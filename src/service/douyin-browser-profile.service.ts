import { ILogger, Logger, Provide, Scope, ScopeEnum } from '@midwayjs/core';
import { existsSync, mkdirSync } from 'fs';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  Browser,
  BrowserContext,
  Cookie,
  ElementHandle,
  Frame,
  HTTPResponse,
  Page,
} from 'puppeteer-core';

const PAGE_TIMEOUT_MS = 60_000;
const BROWSER_ENDPOINT_TIMEOUT_MS = 5_000;
const SELF_PROFILE_TIMEOUT_MS = 10_000;
const SELF_PROFILE_NAVIGATION_TIMEOUT_MS = 15_000;
const MANAGED_PAGE_MARKER_PREFIX = 'streamer-helper:douyin:';
const MANAGED_PAGE_STALE_MS = 15 * 60 * 1000;

const DOUYIN_ORIGINS = [
  'https://www.douyin.com',
  'https://live.douyin.com',
  'https://passport.douyin.com',
  'https://sso.douyin.com',
  'https://auth.zijieapi.com',
];

const BYTE_DANCE_COOKIE_DOMAIN_PATTERN =
  /(^|\.)((douyin|iesdouyin|amemv|bytedance|snssdk|toutiao|zijieapi)\.com)$/i;

const AUTHENTICATED_COOKIE_NAMES = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_guard',
  'sid_tt',
  'sid_ucp_v1',
  'ssid_ucp_v1',
  'uid_tt',
  'uid_tt_ss',
  'passport_auth_status',
]);

const VERIFICATION_METHOD_LABELS = {
  receive_sms: ['接收短信验证码', '接收短信验证'],
  face: ['手机刷脸验证', '手机刷脸认证'],
  send_sms: ['发送短信验证', '发送短信验证码'],
} as const;

const VERIFICATION_SUBMIT_LABELS = [
  '确定',
  '确认',
  '提交',
  '验证',
  '下一步',
  '完成',
  '登录',
];

export type DouyinProfileProbeState =
  | 'valid'
  | 'challenged'
  | 'expired'
  | 'transient';

export type DouyinProfileChallenge = 'captcha' | 'second_verification';

export type DouyinProfileVerificationMethod =
  | 'receive_sms'
  | 'face'
  | 'send_sms';

export interface DouyinCookieDiagnostics {
  cookieNames: string[];
  authenticatedCookieNames: string[];
  authExpiresAt?: Date;
}

export interface DouyinProfileProbeResult extends DouyinCookieDiagnostics {
  state: DouyinProfileProbeState;
  finalUrl: string;
  statusCode?: number;
  challenge?: DouyinProfileChallenge;
  reason?: string;
}

export interface DouyinLiveRoomPageResult extends DouyinProfileProbeResult {
  html?: string;
}

export interface DouyinBrowserLoginTarget {
  browser: Browser;
  browserContext: BrowserContext;
  page: Page;
  ownsBrowser: boolean;
  pageMarker: string;
  ownsLocalProfileLease: boolean;
}

interface FrameSnapshot {
  text: string;
  title: string;
  html: string;
  isTopLevel: boolean;
}

interface DouyinSelfProfileState {
  httpStatus?: number;
  statusCode?: number;
  hasStableUserId: boolean;
  loginRequired: boolean;
  challenge?: DouyinProfileChallenge;
  errorCode?: 'timeout' | 'request_failed' | 'invalid_response';
}

@Provide()
@Scope(ScopeEnum.Singleton)
export class DouyinBrowserProfileService {
  @Logger()
  private logger: ILogger;

  private activePageMarkers = new Set<string>();
  private localProfileLease = false;

  /**
   * Creates an interactive page backed by Chrome's default profile.
   *
   * The default context is intentional: remote Chrome persists it through its
   * user-data-dir. Callers must release the target with closeTarget(), which
   * never closes that context.
   */
  async createLoginTarget(roomId?: string): Promise<DouyinBrowserLoginTarget> {
    const target = await this.createBrowserTarget();
    const webRid = roomId?.trim();
    const url = webRid
      ? `https://live.douyin.com/${encodeURIComponent(webRid)}`
      : 'https://www.douyin.com/';

    try {
      await this.navigate(target.page, url);
      return target;
    } catch (error) {
      await this.closeTarget(target);
      throw error;
    }
  }

  /**
   * Releases one page and the CDP connection. The persistent default browser
   * context is never closed. A locally launched browser is closed because it is
   * owned by this service; its user-data-dir remains on disk.
   */
  async closeTarget(target: DouyinBrowserLoginTarget): Promise<void> {
    try {
      if (!target.page.isClosed()) {
        await target.page.close();
      }
    } catch (error) {
      this.logger?.debug('Failed to close Douyin browser page', {
        error: this.errorMessage(error),
      });
    }

    try {
      if (target.ownsBrowser) {
        await target.browser.close();
      } else {
        await target.browser.disconnect();
      }
    } catch (error) {
      this.logger?.debug('Failed to release Douyin browser connection', {
        error: this.errorMessage(error),
      });
    } finally {
      this.activePageMarkers.delete(target.pageMarker);
      if (target.ownsLocalProfileLease) {
        this.localProfileLease = false;
      }
    }
  }

  /**
   * Probes the persisted authenticated profile. Cookie names are diagnostics,
   * never the success criterion by themselves. A challenge/login page is
   * classified before any navigation so a provisional login cookie cannot
   * skip secondary verification.
   */
  async probe(page: Page, _roomId?: string): Promise<DouyinProfileProbeResult> {
    void _roomId;
    let diagnostics = await this.safeCookieDiagnostics(page.browserContext());

    try {
      const initialChallenge = await this.detectChallenge(page);
      if (initialChallenge) {
        return this.probeResult(page, diagnostics, 'challenged', undefined, {
          challenge: initialChallenge,
          reason:
            initialChallenge === 'second_verification'
              ? 'Douyin secondary verification is required'
              : 'Douyin captcha verification is required',
        });
      }

      if (await this.isLoginRequired(page)) {
        return this.probeResult(page, diagnostics, 'expired', undefined, {
          reason: 'Douyin login is required',
        });
      }

      await this.navigate(
        page,
        'https://www.douyin.com/',
        SELF_PROFILE_NAVIGATION_TIMEOUT_MS
      );

      const navigatedChallenge = await this.detectChallenge(page);
      if (navigatedChallenge) {
        return this.probeResult(page, diagnostics, 'challenged', undefined, {
          challenge: navigatedChallenge,
          reason:
            navigatedChallenge === 'second_verification'
              ? 'Douyin secondary verification is required'
              : 'Douyin captcha verification is required',
        });
      }

      if (await this.isLoginRequired(page)) {
        return this.probeResult(page, diagnostics, 'expired', undefined, {
          reason: 'Douyin login is required',
        });
      }

      const profile = await this.fetchSelfProfileState(page);
      diagnostics = await this.safeCookieDiagnostics(page.browserContext());
      if (profile.challenge) {
        return this.probeResult(
          page,
          diagnostics,
          'challenged',
          profile.httpStatus,
          {
            challenge: profile.challenge,
            reason:
              profile.challenge === 'second_verification'
                ? 'Douyin secondary verification is required'
                : 'Douyin captcha verification is required',
          }
        );
      }
      if (
        profile.loginRequired ||
        profile.httpStatus === 401 ||
        profile.statusCode === 8 ||
        profile.statusCode === 2483
      ) {
        return this.probeResult(
          page,
          diagnostics,
          'expired',
          profile.httpStatus,
          {
            reason: 'Douyin account session is not authenticated',
          }
        );
      }
      if (profile.statusCode === 0 && profile.hasStableUserId) {
        return this.probeResult(page, diagnostics, 'valid', profile.httpStatus);
      }

      const reason = profile.errorCode
        ? `Douyin account validation ${profile.errorCode.replace('_', ' ')}`
        : profile.statusCode === 0
        ? 'Douyin account endpoint did not confirm a stable identity'
        : profile.statusCode !== undefined
        ? `Douyin account endpoint returned status ${profile.statusCode}`
        : `Douyin account endpoint returned HTTP ${
            profile.httpStatus ?? 'unknown'
          }`;
      return this.probeResult(
        page,
        diagnostics,
        'transient',
        profile.httpStatus,
        { reason }
      );
    } catch (error) {
      this.logger?.debug('Douyin browser profile probe was inconclusive', {
        error: this.errorMessage(error),
      });
      return this.probeResult(page, diagnostics, 'transient', undefined, {
        reason: this.transientReason(error),
      });
    }
  }

  /**
   * Fetches a live room through the persisted browser profile. This is the
   * browser-backed equivalent of a page HTTP request and preserves Chrome's
   * cookie jar, storage, UA, TLS stack, and response cookie updates.
   */
  async fetchLiveRoomPage(webRid: string): Promise<DouyinLiveRoomPageResult> {
    const normalizedWebRid = webRid.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(normalizedWebRid)) {
      return {
        state: 'transient',
        finalUrl: '',
        cookieNames: [],
        authenticatedCookieNames: [],
        reason: 'Douyin room identifier is invalid',
      };
    }

    const target = await this.createBrowserTarget();
    try {
      const response = await this.navigate(
        target.page,
        `https://live.douyin.com/${encodeURIComponent(normalizedWebRid)}`
      );
      const diagnostics = await this.safeCookieDiagnostics(
        target.browserContext
      );
      const result = await this.classifyCurrentPage(
        target.page,
        diagnostics,
        response,
        true
      );

      if (result.state !== 'valid') {
        return result;
      }

      return {
        ...result,
        html: await target.page.content(),
      };
    } catch (error) {
      this.logger?.debug('Failed to fetch Douyin room through browser', {
        webRid: normalizedWebRid,
        error: this.errorMessage(error),
      });
      return {
        state: 'transient',
        finalUrl: target.page.url(),
        cookieNames: [],
        authenticatedCookieNames: [],
        reason: this.transientReason(error),
      };
    } finally {
      await this.closeTarget(target);
    }
  }

  /**
   * Clears the dedicated Douyin profile without deleting the profile folder.
   * BrowserContext Cookie deletion preserves exact domain/path semantics.
   */
  async logout(): Promise<void> {
    const target = await this.createBrowserTarget();
    const failures: string[] = [];
    let client: Awaited<ReturnType<Page['createCDPSession']>> | undefined;

    try {
      try {
        const cookies = (await target.browserContext.cookies()).filter(cookie =>
          this.isByteDanceCookieDomain(cookie.domain)
        );
        if (cookies.length > 0) {
          await target.browserContext.deleteCookie(...cookies);
        }
      } catch (error) {
        failures.push(`cookies: ${this.errorMessage(error)}`);
      }

      try {
        client = await target.page.createCDPSession();
        for (const origin of DOUYIN_ORIGINS) {
          try {
            await client.send('Storage.clearDataForOrigin', {
              origin,
              storageTypes: 'all',
            });
          } catch (error) {
            failures.push(`${origin}: ${this.errorMessage(error)}`);
          }
        }
      } catch (error) {
        failures.push(`storage: ${this.errorMessage(error)}`);
      } finally {
        if (client) {
          try {
            await client.detach();
          } catch {
            // The browser connection may already be closing.
          }
        }
      }
    } finally {
      await this.closeTarget(target);
    }

    if (failures.length > 0) {
      throw new Error(
        `Failed to fully clear Douyin browser profile: ${failures.join('; ')}`
      );
    }
  }

  async getCookieDiagnostics(
    browserContext: BrowserContext
  ): Promise<DouyinCookieDiagnostics> {
    return this.buildCookieDiagnostics(await browserContext.cookies());
  }

  buildCookieDiagnostics(cookies: Cookie[]): DouyinCookieDiagnostics {
    const byteDanceCookies = cookies.filter(
      cookie =>
        Boolean(cookie.name) && this.isByteDanceCookieDomain(cookie.domain)
    );
    const cookieNames = Array.from(
      new Set(byteDanceCookies.map(cookie => cookie.name))
    ).sort();
    const authenticatedCookies = byteDanceCookies.filter(
      cookie =>
        Boolean(cookie.value) &&
        AUTHENTICATED_COOKIE_NAMES.has(cookie.name.toLowerCase())
    );
    const authenticatedCookieNames = Array.from(
      new Set(authenticatedCookies.map(cookie => cookie.name))
    ).sort();
    const persistentExpirations = authenticatedCookies
      .map(cookie => cookie.expires)
      .filter(expires => Number.isFinite(expires) && expires > 0);

    return {
      cookieNames,
      authenticatedCookieNames,
      authExpiresAt:
        persistentExpirations.length > 0
          ? new Date(Math.min(...persistentExpirations) * 1000)
          : undefined,
    };
  }

  /**
   * Detects both the first-party page and cross-origin verification frames.
   */
  async detectChallenge(
    page: Page
  ): Promise<DouyinProfileChallenge | undefined> {
    const snapshots = await this.collectFrameSnapshots(page);

    if (
      snapshots.some(snapshot => this.isSecondaryVerificationSnapshot(snapshot))
    ) {
      return 'second_verification';
    }

    if (snapshots.some(snapshot => this.isCaptchaSnapshot(snapshot))) {
      return 'captcha';
    }

    return undefined;
  }

  async isLoginRequired(page: Page): Promise<boolean> {
    try {
      const hostname = new URL(page.url()).hostname.toLowerCase();
      if (hostname === 'passport.douyin.com' || hostname === 'sso.douyin.com') {
        return true;
      }
    } catch {
      // about:blank and transient navigation URLs are handled by page text.
    }

    const snapshots = await this.collectFrameSnapshots(page);
    return snapshots.some(snapshot =>
      /扫码登录|手机号登录|密码登录|验证码登录|请先登录|请登录后继续|登录已失效|重新登录|立即登录/.test(
        snapshot.text
      )
    );
  }

  async openLoginPanel(page: Page): Promise<boolean> {
    return this.clickVisibleTextAcrossFrames(page, [
      '扫码登录',
      '立即登录',
      '登录',
    ]);
  }

  async selectVerificationMethod(
    page: Page,
    method: DouyinProfileVerificationMethod
  ): Promise<boolean> {
    const labels = VERIFICATION_METHOD_LABELS[method];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await this.clickVisibleTextAcrossFrames(page, labels)) {
        return true;
      }
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    return false;
  }

  async getAvailableVerificationMethods(
    page: Page
  ): Promise<DouyinProfileVerificationMethod[]> {
    const methods = Object.keys(
      VERIFICATION_METHOD_LABELS
    ) as DouyinProfileVerificationMethod[];
    const availableMethods: DouyinProfileVerificationMethod[] = [];

    for (const method of methods) {
      if (
        await this.hasVisibleTextAcrossFrames(
          page,
          VERIFICATION_METHOD_LABELS[method]
        )
      ) {
        availableMethods.push(method);
      }
    }

    return availableMethods;
  }

  async fillVerificationCode(page: Page, code: string): Promise<boolean> {
    if (!/^\d{4,8}$/.test(code)) {
      throw new Error('Douyin verification code must contain 4 to 8 digits');
    }

    for (const frame of page.frames()) {
      if (!(await this.isFrameVisible(frame))) {
        continue;
      }
      try {
        const filled = await frame.evaluate(value => {
          const scope = globalThis as any;
          const doc = scope.document;
          const inputs = Array.from(doc.querySelectorAll('input')) as any[];
          const input = inputs.find(node => {
            const rect = node.getBoundingClientRect();
            const style = scope.getComputedStyle(node);
            const label = [
              node.placeholder,
              node.getAttribute('aria-label'),
              node.name,
            ]
              .filter(Boolean)
              .join(' ');
            return (
              /验证码|verification|code/i.test(label) &&
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none'
            );
          });
          if (!input) {
            return false;
          }

          const descriptor = Object.getOwnPropertyDescriptor(
            scope.HTMLInputElement.prototype,
            'value'
          );
          descriptor?.set?.call(input, value);
          input.dispatchEvent(new scope.Event('input', { bubbles: true }));
          input.dispatchEvent(new scope.Event('change', { bubbles: true }));
          input.focus();
          return true;
        }, code);
        if (filled) {
          return true;
        }
      } catch {
        // Continue with the next frame while Douyin replaces verification UI.
      }
    }

    return false;
  }

  async submitVerificationCode(page: Page, code: string): Promise<boolean> {
    if (!(await this.fillVerificationCode(page, code))) {
      return false;
    }

    const submitted = await this.clickVisibleTextAcrossFrames(
      page,
      VERIFICATION_SUBMIT_LABELS
    );
    if (!submitted) {
      await page.keyboard.press('Enter');
    }
    return true;
  }

  /**
   * Calls Douyin's account-only endpoint inside the persisted browser profile.
   * The page returns only authentication signals; no user field or identifier
   * crosses the browser boundary.
   */
  private async fetchSelfProfileState(
    page: Page
  ): Promise<DouyinSelfProfileState> {
    const evaluation = page.evaluate(async timeoutMs => {
      const scope = globalThis as any;
      const controller = new scope.AbortController();
      const timer = scope.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await scope.fetch('/aweme/v1/web/user/profile/self/', {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
          },
          cache: 'no-store',
          signal: controller.signal,
        });
        const body = String(await response.text()).slice(0, 100_000);
        const captcha =
          /captcha\/index\.js|secsdk-captcha|argus-csp-token|验证码中间页|访问验证/i.test(
            body
          );
        const secondaryVerification =
          /身份验证|身份认证|安全验证/.test(body) &&
          /短信验证码|刷脸验证|刷脸认证|本人操作|验证方式|接收短信|发送短信/.test(
            body
          );

        let payload: any;
        try {
          payload = JSON.parse(body);
        } catch {
          return {
            httpStatus: response.status,
            hasStableUserId: false,
            loginRequired:
              /请先登录|登录后继续|用户未登录|登录已失效|重新登录/.test(body),
            challenge: secondaryVerification
              ? 'second_verification'
              : captcha
              ? 'captcha'
              : undefined,
            errorCode: 'invalid_response',
          };
        }

        const rawStatusCode = payload?.status_code;
        const statusCode =
          typeof rawStatusCode === 'number' && Number.isFinite(rawStatusCode)
            ? rawStatusCode
            : undefined;
        const user = payload?.user || payload?.data?.user;
        const hasStableUserId = Boolean(
          user &&
            [user.sec_uid, user.uid, user.unique_id].some(
              value =>
                (typeof value === 'string' && value.trim().length > 0) ||
                (typeof value === 'number' &&
                  Number.isFinite(value) &&
                  value > 0)
            )
        );
        const statusMessage =
          typeof payload?.status_msg === 'string' ? payload.status_msg : '';

        return {
          httpStatus: response.status,
          statusCode,
          hasStableUserId,
          loginRequired:
            statusCode === 8 ||
            statusCode === 2483 ||
            /请先登录|登录后继续|用户未登录|登录已失效|重新登录/.test(
              statusMessage
            ),
          challenge: secondaryVerification
            ? 'second_verification'
            : captcha
            ? 'captcha'
            : undefined,
        };
      } catch (error) {
        return {
          hasStableUserId: false,
          loginRequired: false,
          errorCode:
            error instanceof scope.DOMException && error.name === 'AbortError'
              ? 'timeout'
              : 'request_failed',
        };
      } finally {
        scope.clearTimeout(timer);
      }
    }, SELF_PROFILE_TIMEOUT_MS) as Promise<DouyinSelfProfileState>;

    return await this.withTimeout(
      evaluation,
      SELF_PROFILE_TIMEOUT_MS + 2_000,
      'Douyin account validation timed out'
    );
  }

  private async classifyCurrentPage(
    page: Page,
    diagnostics: DouyinCookieDiagnostics,
    response: HTTPResponse | null,
    requireRoomMarker: boolean
  ): Promise<DouyinProfileProbeResult> {
    const statusCode = response?.status();
    const challenge = await this.detectChallenge(page);
    if (challenge) {
      return this.probeResult(page, diagnostics, 'challenged', statusCode, {
        challenge,
        reason:
          challenge === 'second_verification'
            ? 'Douyin secondary verification is required'
            : 'Douyin captcha verification is required',
      });
    }

    if (await this.isLoginRequired(page)) {
      return this.probeResult(page, diagnostics, 'expired', statusCode, {
        reason: 'Douyin login is required',
      });
    }

    if (statusCode === 401) {
      return this.probeResult(page, diagnostics, 'expired', statusCode, {
        reason: 'Douyin rejected the authenticated session',
      });
    }

    if (statusCode !== undefined && statusCode >= 400) {
      return this.probeResult(page, diagnostics, 'transient', statusCode, {
        reason: `Douyin returned HTTP ${statusCode}`,
      });
    }

    const html = await page.content();
    if (!html.trim()) {
      return this.probeResult(page, diagnostics, 'transient', statusCode, {
        reason: 'Douyin returned an empty browser page',
      });
    }

    if (requireRoomMarker && !this.hasRoomInfoMarker(html)) {
      return this.probeResult(page, diagnostics, 'transient', statusCode, {
        reason: 'Douyin room information was not found',
      });
    }

    return this.probeResult(page, diagnostics, 'valid', statusCode);
  }

  private probeResult(
    page: Page,
    diagnostics: DouyinCookieDiagnostics,
    state: DouyinProfileProbeState,
    statusCode?: number,
    details?: {
      challenge?: DouyinProfileChallenge;
      reason?: string;
    }
  ): DouyinProfileProbeResult {
    return {
      state,
      finalUrl: page.url(),
      statusCode,
      challenge: details?.challenge,
      reason: details?.reason,
      ...diagnostics,
    };
  }

  private async safeCookieDiagnostics(
    browserContext: BrowserContext
  ): Promise<DouyinCookieDiagnostics> {
    try {
      return await this.getCookieDiagnostics(browserContext);
    } catch {
      return {
        cookieNames: [],
        authenticatedCookieNames: [],
      };
    }
  }

  private async collectFrameSnapshots(page: Page): Promise<FrameSnapshot[]> {
    const snapshots: FrameSnapshot[] = [];
    const frames = page.frames();
    for (const [index, frame] of frames.entries()) {
      try {
        if (!(await this.isFrameVisible(frame))) {
          continue;
        }
        const parentFrame =
          typeof frame.parentFrame === 'function'
            ? frame.parentFrame()
            : index === 0
            ? null
            : undefined;
        snapshots.push({
          ...(await this.getFrameSnapshot(frame)),
          isTopLevel: parentFrame === null,
        });
      } catch {
        // Cross-origin frames are individually inspectable, but can disappear
        // during verification navigation. Missing one frame is transient.
      }
    }
    return snapshots;
  }

  private async getFrameSnapshot(
    frame: Frame
  ): Promise<Omit<FrameSnapshot, 'isTopLevel'>> {
    return frame.evaluate(() => {
      const doc = (globalThis as any).document;
      const normalize = (value: unknown) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim();
      return {
        text: normalize(doc.body?.innerText || doc.body?.textContent),
        title: normalize(doc.title),
        html: String(doc.documentElement?.innerHTML || '').slice(0, 50_000),
      };
    });
  }

  private isSecondaryVerificationSnapshot(snapshot: FrameSnapshot): boolean {
    return (
      /身份验证|身份认证|安全验证/.test(snapshot.text) &&
      /短信验证码|刷脸验证|刷脸认证|本人操作|验证方式|接收短信|发送短信/.test(
        snapshot.text
      )
    );
  }

  private isCaptchaSnapshot(snapshot: FrameSnapshot): boolean {
    return (
      /验证码中间页|captcha|访问验证/i.test(snapshot.title) ||
      (!snapshot.isTopLevel &&
        /captcha\/index\.js|secsdk-captcha|argus-csp-token/i.test(
          snapshot.html
        )) ||
      (/安全验证/.test(snapshot.text) &&
        /拖动滑块|完成验证|验证后继续|网络环境存在风险/.test(snapshot.text))
    );
  }

  private async hasVisibleTextAcrossFrames(
    page: Page,
    labels: readonly string[]
  ): Promise<boolean> {
    return this.findVisibleTextAcrossFrames(page, labels, false);
  }

  private async clickVisibleTextAcrossFrames(
    page: Page,
    labels: readonly string[]
  ): Promise<boolean> {
    return this.findVisibleTextAcrossFrames(page, labels, true);
  }

  private async findVisibleTextAcrossFrames(
    page: Page,
    labels: readonly string[],
    click: boolean
  ): Promise<boolean> {
    for (const frame of page.frames()) {
      if (!(await this.isFrameVisible(frame))) {
        continue;
      }
      let handle: Awaited<ReturnType<Frame['evaluateHandle']>> | undefined;
      try {
        handle = await frame.evaluateHandle(
          values => {
            const scope = globalThis as any;
            const doc = scope.document;
            const normalize = (text: unknown) =>
              String(text || '')
                .replace(/\s+/g, '')
                .trim();
            const normalizedLabels = new Set(values.map(normalize));
            const matches = Array.from(
              doc.querySelectorAll(
                'button, a, [role="button"], [tabindex], label, div, span'
              )
            ).filter(element => {
              const node = element as any;
              const rect = node.getBoundingClientRect();
              const style = scope.getComputedStyle(node);
              return (
                normalizedLabels.has(
                  normalize(node.innerText || node.textContent)
                ) &&
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
              );
            }) as any[];
            const labelElement =
              matches.find(
                element =>
                  !matches.some(
                    other => other !== element && element.contains(other)
                  )
              ) || matches[0];
            const target =
              labelElement?.closest(
                'button, a, [role="button"], [tabindex], label'
              ) || labelElement;
            if (
              !target ||
              target.disabled ||
              target.getAttribute?.('aria-disabled') === 'true'
            ) {
              return null;
            }
            return target;
          },
          [...labels]
        );
        const target = handle.asElement() as ElementHandle<Element> | null;
        if (!target) {
          continue;
        }
        if (click) {
          await target.click();
        }
        return true;
      } catch {
        // Continue across frames while Douyin replaces verification UI.
      } finally {
        await handle?.dispose().catch(() => undefined);
      }
    }
    return false;
  }

  private async isFrameVisible(frame: Frame): Promise<boolean> {
    let currentFrame: Frame | undefined = frame;
    const visited = new Set<Frame>();

    while (
      currentFrame &&
      !visited.has(currentFrame) &&
      typeof currentFrame.parentFrame === 'function'
    ) {
      visited.add(currentFrame);
      const parentFrame = currentFrame.parentFrame();
      if (!parentFrame) {
        return true;
      }

      let frameElement: Awaited<ReturnType<Frame['frameElement']>> | undefined;
      try {
        frameElement = await currentFrame.frameElement();
        const isActive =
          (await frameElement.isVisible()) &&
          (await frameElement.evaluate(element => {
            const doc = element.ownerDocument;
            const view = doc.defaultView;
            if (!view) {
              return false;
            }
            const rect = element.getBoundingClientRect();
            if (
              rect.width < 2 ||
              rect.height < 2 ||
              rect.right <= 0 ||
              rect.bottom <= 0 ||
              rect.left >= view.innerWidth ||
              rect.top >= view.innerHeight
            ) {
              return false;
            }

            let current: Element | null = element;
            while (current) {
              const style = view.getComputedStyle(current);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.visibility === 'collapse' ||
                Number(style.opacity) <= 0.01 ||
                style.pointerEvents === 'none'
              ) {
                return false;
              }
              current = current.parentElement;
            }

            const x = Math.min(
              Math.max(rect.left + rect.width / 2, 0),
              Math.max(view.innerWidth - 1, 0)
            );
            const y = Math.min(
              Math.max(rect.top + rect.height / 2, 0),
              Math.max(view.innerHeight - 1, 0)
            );
            const hitTarget = doc.elementFromPoint(x, y);
            return (
              !hitTarget || hitTarget === element || element.contains(hitTarget)
            );
          }));
        if (!isActive) {
          return false;
        }
      } catch {
        return false;
      } finally {
        await frameElement?.dispose().catch(() => undefined);
      }
      currentFrame = parentFrame;
    }

    return true;
  }

  private async createBrowserTarget(): Promise<DouyinBrowserLoginTarget> {
    const puppeteer = await this.importPuppeteer();
    const remoteEndpoint = this.getBrowserEndpoint();
    let browser: Browser;
    let ownsBrowser = false;
    let ownsLocalProfileLease = false;

    if (remoteEndpoint) {
      browser = await puppeteer.connect(
        await this.resolveRemoteBrowserConnection(remoteEndpoint)
      );
    } else {
      if (this.localProfileLease) {
        throw new Error(
          'Local Douyin browser profile is already in use; configure DOUYIN_BROWSER_ENDPOINT for concurrent browser access'
        );
      }
      this.localProfileLease = true;
      ownsLocalProfileLease = true;
      const executablePath = this.resolveChromiumExecutablePath();
      if (!executablePath) {
        this.localProfileLease = false;
        throw new Error(
          'Browser endpoint is not configured and Chromium was not found'
        );
      }

      const userDataDir = this.getLocalProfileDirectory();
      mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      try {
        browser = await puppeteer.launch({
          executablePath,
          userDataDir,
          headless: true,
          args: this.buildChromiumLaunchArgs(),
        });
      } catch (error) {
        this.localProfileLease = false;
        throw error;
      }
      ownsBrowser = true;
    }

    const pageMarker = `${MANAGED_PAGE_MARKER_PREFIX}${Date.now()}:${randomUUID()}`;
    this.activePageMarkers.add(pageMarker);
    try {
      const browserContext = browser.defaultBrowserContext();
      await this.cleanupOrphanedPages(browserContext);
      const page = await browserContext.newPage();
      await page.evaluateOnNewDocument(marker => {
        (globalThis as any).window.name = marker;
      }, pageMarker);
      await page.evaluate(marker => {
        (globalThis as any).window.name = marker;
      }, pageMarker);
      await page.setViewport({
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
      });
      return {
        browser,
        browserContext,
        page,
        ownsBrowser,
        pageMarker,
        ownsLocalProfileLease,
      };
    } catch (error) {
      this.activePageMarkers.delete(pageMarker);
      if (ownsBrowser) {
        await browser.close().catch(() => undefined);
      } else {
        await browser.disconnect().catch(() => undefined);
      }
      if (ownsLocalProfileLease) {
        this.localProfileLease = false;
      }
      throw error;
    }
  }

  private async cleanupOrphanedPages(
    browserContext: BrowserContext
  ): Promise<void> {
    if (typeof browserContext.pages !== 'function') {
      return;
    }

    const pages = await browserContext.pages();
    for (const page of pages) {
      try {
        const marker = await page.evaluate(() =>
          String((globalThis as any).window?.name || '')
        );
        if (
          marker.startsWith(MANAGED_PAGE_MARKER_PREFIX) &&
          !this.activePageMarkers.has(marker) &&
          this.isManagedPageMarkerStale(marker) &&
          !page.isClosed()
        ) {
          await page.close();
        }
      } catch {
        // Ignore pages that are navigating or closing.
      }
    }
  }

  private isManagedPageMarkerStale(marker: string): boolean {
    const createdAt = Number(
      marker.slice(MANAGED_PAGE_MARKER_PREFIX.length).split(':', 1)[0]
    );
    return (
      Number.isFinite(createdAt) &&
      createdAt > 0 &&
      Date.now() - createdAt >= MANAGED_PAGE_STALE_MS
    );
  }

  private getBrowserEndpoint(): string {
    return (
      process.env.DOUYIN_BROWSER_ENDPOINT?.trim() ||
      process.env.DOUYIN_BROWSER_WS_ENDPOINT?.trim() ||
      process.env.BROWSER_WS_ENDPOINT?.trim() ||
      ''
    );
  }

  private getLocalProfileDirectory(): string {
    return (
      process.env.DOUYIN_BROWSER_PROFILE_DIR?.trim() ||
      path.join(os.homedir(), '.streamer-helper', 'douyin-browser-profile')
    );
  }

  private resolveChromiumExecutablePath(): string | undefined {
    const candidates = [
      process.env.CHROMIUM_PATH,
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].filter(Boolean) as string[];

    return candidates.find(candidate => existsSync(candidate));
  }

  private async resolveRemoteBrowserConnection(endpoint: string): Promise<{
    browserWSEndpoint: string;
    headers?: Record<string, string>;
  }> {
    if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
      const hostHeader = this.getBrowserHostHeader(endpoint);
      return {
        browserWSEndpoint: endpoint,
        headers: hostHeader ? { Host: hostHeader } : undefined,
      };
    }

    const endpointUrl = new URL(endpoint);
    const versionUrl = new URL('/json/version', endpointUrl);
    const hostHeader = this.getBrowserHostHeader(endpoint);
    const response = await this.requestText(versionUrl, hostHeader);
    const version = JSON.parse(response) as {
      webSocketDebuggerUrl?: string;
    };
    if (!version.webSocketDebuggerUrl) {
      throw new Error(
        'Browser endpoint did not return a WebSocket debugger URL'
      );
    }

    const wsUrl = new URL(version.webSocketDebuggerUrl);
    wsUrl.protocol = endpointUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.hostname = endpointUrl.hostname;
    wsUrl.port = endpointUrl.port;
    return {
      browserWSEndpoint: wsUrl.toString(),
      headers: hostHeader ? { Host: hostHeader } : undefined,
    };
  }

  private getBrowserHostHeader(endpoint: string): string {
    const configured = process.env.DOUYIN_BROWSER_HOST_HEADER?.trim();
    if (configured) {
      return configured;
    }

    const endpointUrl = new URL(endpoint);
    if (
      endpointUrl.hostname === 'localhost' ||
      endpointUrl.hostname === '127.0.0.1'
    ) {
      return '';
    }

    const port =
      endpointUrl.port ||
      (endpointUrl.protocol === 'https:' || endpointUrl.protocol === 'wss:'
        ? '443'
        : '80');
    return `127.0.0.1:${port}`;
  }

  private requestText(url: URL, hostHeader: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: 'GET',
          headers: hostHeader ? { Host: hostHeader } : undefined,
        },
        response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => {
            body += chunk;
          });
          response.on('end', () => {
            if ((response.statusCode || 500) >= 400) {
              reject(
                new Error(
                  `Browser endpoint returned HTTP ${response.statusCode}`
                )
              );
              return;
            }
            resolve(body);
          });
        }
      );
      request.setTimeout(BROWSER_ENDPOINT_TIMEOUT_MS, () => {
        request.destroy(new Error('Browser endpoint request timed out'));
      });
      request.on('error', reject);
      request.end();
    });
  }

  private async importPuppeteer(): Promise<typeof import('puppeteer-core')> {
    const dynamicImport = new Function(
      'specifier',
      'return import(specifier)'
    ) as (specifier: string) => Promise<typeof import('puppeteer-core')>;
    return dynamicImport('puppeteer-core');
  }

  private buildChromiumLaunchArgs(): string[] {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ];
    const proxy =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy;
    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
    }
    return args;
  }

  private async navigate(
    page: Page,
    url: string,
    timeout = PAGE_TIMEOUT_MS
  ): Promise<HTTPResponse | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
      } catch (error) {
        if (attempt === 1 || !this.isTransientNavigationError(error)) {
          throw error;
        }
      }
    }
    return null;
  }

  private isTransientNavigationError(error: unknown): boolean {
    return /execution context was destroyed|navigating frame was detached|frame was detached|cannot find context with specified id/i.test(
      this.errorMessage(error)
    );
  }

  private hasRoomInfoMarker(html: string): boolean {
    return (
      html.includes('__pace_f') &&
      (html.includes('roomInfo') ||
        html.includes('"room"') ||
        html.includes('roomStore'))
    );
  }

  private isByteDanceCookieDomain(domain: string): boolean {
    return BYTE_DANCE_COOKIE_DOMAIN_PATTERN.test(domain.replace(/^\./, ''));
  }

  private transientReason(error: unknown): string {
    return this.isTransientNavigationError(error)
      ? 'Douyin page is still navigating'
      : this.errorMessage(error);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
