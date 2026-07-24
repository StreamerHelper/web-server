import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { Browser, BrowserContext, Cookie, Page } from 'puppeteer-core';
import { DouyinCredentialRepository } from '../repository/douyin-credential.repository';
import { getConfig } from '../config/loader';

const VERIFY_TIMEOUT_MS = 15000;
const BROWSER_LOGIN_TTL_MS = 10 * 60 * 1000;
const BROWSER_LOGIN_POLL_MS = 2000;
const COOKIE_ATTRIBUTE_NAMES = new Set([
  'domain',
  'path',
  'expires',
  'max-age',
  'secure',
  'httponly',
  'samesite',
]);
const IGNORED_DOUYIN_COOKIE_NAMES = new Set(['s_v_web_id']);
const AUTHENTICATED_COOKIE_NAMES = new Set([
  'sessionid',
  'sid_guard',
  'sid_tt',
  'uid_tt',
  'passport_auth_status',
]);
const BYTE_DANCE_COOKIE_DOMAIN_PATTERN =
  /(^|\.)((douyin|iesdouyin|amemv|bytedance|snssdk|toutiao)\.com)$/i;
const DOUYIN_VERIFICATION_METHOD_LABELS = {
  receive_sms: '接收短信验证码',
  face: '手机刷脸验证',
  send_sms: '发送短信验证',
} as const;
const DOUYIN_VERIFICATION_SUBMIT_LABELS = [
  '确定',
  '确认',
  '提交',
  '验证',
  '下一步',
  '完成',
  '登录',
];

function hasInvalidCookieNameCharacter(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.charCodeAt(0);
    return (
      character.trim() === '' ||
      character === ';' ||
      character === ',' ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });
}

export type DouyinBrowserLoginState =
  | 'initializing'
  | 'waiting'
  | 'verification_required'
  | 'authenticated'
  | 'expired'
  | 'failed'
  | 'cancelled';

export type DouyinVerificationMethod = 'receive_sms' | 'face' | 'send_sms';

export type DouyinVerificationStage =
  | 'choose_method'
  | 'processing'
  | 'awaiting_code'
  | 'awaiting_external';

export interface DouyinBrowserLoginVerification {
  stage: DouyinVerificationStage;
  method?: DouyinVerificationMethod;
  availableMethods: DouyinVerificationMethod[];
  prompt?: string;
}

export type DouyinBrowserLoginInteraction =
  | {
      type: 'select_verification_method';
      method: DouyinVerificationMethod;
    }
  | {
      type: 'submit_verification_code';
      code: string;
    };

interface DouyinBrowserLoginSession {
  id: string;
  status: DouyinBrowserLoginState;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  browser?: Browser;
  browserContext?: BrowserContext;
  page?: Page;
  ownsBrowser?: boolean;
  pollTimer?: NodeJS.Timeout;
  expireTimer?: NodeJS.Timeout;
  cookieNames?: string[];
  verifiedAt?: Date;
  error?: string;
  verification?: DouyinBrowserLoginVerification;
}

export class DouyinCredentialError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface NormalizedDouyinCookie {
  cookieHeader: string;
  cookieNames: string[];
}

export interface DouyinAuthStatus {
  isAuthenticated: boolean;
  source?: 'database' | 'config';
  cookieNames?: string[];
  verifiedAt?: Date | null;
  updatedAt?: Date;
  lastValidationError?: string | null;
}

export interface DouyinCookieVerification {
  ok: boolean;
  cookieNames: string[];
  verifiedAt?: Date;
  statusCode?: number;
  captchaDetected?: boolean;
  error?: string;
}

export interface DouyinBrowserLoginStatus {
  sessionId: string;
  status: DouyinBrowserLoginState;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  screenshotUpdatedAt?: Date;
  cookieNames?: string[];
  verifiedAt?: Date;
  error?: string;
  verification?: DouyinBrowserLoginVerification;
}

@Provide()
@Scope(ScopeEnum.Singleton)
export class DouyinAuthService {
  @Inject()
  private credentialRepository: DouyinCredentialRepository;

  @Logger()
  private logger: ILogger;

  private browserLoginSessions = new Map<string, DouyinBrowserLoginSession>();

  async getStatus(): Promise<DouyinAuthStatus> {
    const credential = await this.credentialRepository.findLatest();
    if (credential) {
      return {
        isAuthenticated: true,
        source: 'database',
        cookieNames: credential.cookieNames,
        verifiedAt: credential.verifiedAt,
        updatedAt: credential.updatedAt,
        lastValidationError: credential.lastValidationError,
      };
    }

    const configuredCookie = this.getConfiguredCookie();
    if (!configuredCookie) {
      return { isAuthenticated: false };
    }

    try {
      const normalized = this.normalizeCookieHeader(configuredCookie);
      return {
        isAuthenticated: true,
        source: 'config',
        cookieNames: normalized.cookieNames,
      };
    } catch (error) {
      return {
        isAuthenticated: false,
        source: 'config',
        lastValidationError:
          error instanceof Error ? error.message : 'Invalid configured cookie',
      };
    }
  }

  async saveCookie(
    rawCookie: string,
    options?: { verify?: boolean; roomId?: string }
  ): Promise<{
    status: DouyinAuthStatus;
    verification?: DouyinCookieVerification;
  }> {
    const normalized = this.normalizeCookieHeader(rawCookie);
    let verification: DouyinCookieVerification | undefined;

    if (options?.verify !== false) {
      verification = await this.verifyNormalizedCookie(
        normalized.cookieHeader,
        normalized.cookieNames,
        options?.roomId
      );
      if (!verification.ok) {
        throw new DouyinCredentialError(
          verification.error || 'Douyin Cookie verification failed'
        );
      }
    }

    const saved = await this.credentialRepository.saveCredential({
      cookieHeader: normalized.cookieHeader,
      cookieNames: normalized.cookieNames,
      verifiedAt: verification?.verifiedAt || null,
      lastValidationError: null,
    });

    return {
      status: {
        isAuthenticated: true,
        source: 'database',
        cookieNames: saved.cookieNames,
        verifiedAt: saved.verifiedAt,
        updatedAt: saved.updatedAt,
        lastValidationError: saved.lastValidationError,
      },
      verification,
    };
  }

  async verifyCookie(
    rawCookie?: string,
    roomId?: string
  ): Promise<DouyinCookieVerification> {
    if (rawCookie?.trim()) {
      const normalized = this.normalizeCookieHeader(rawCookie);
      return this.verifyNormalizedCookie(
        normalized.cookieHeader,
        normalized.cookieNames,
        roomId
      );
    }

    const credential = await this.credentialRepository.findLatest();
    if (credential) {
      const verification = await this.verifyNormalizedCookie(
        credential.cookieHeader,
        credential.cookieNames,
        roomId
      );
      await this.credentialRepository.saveCredential({
        cookieHeader: credential.cookieHeader,
        cookieNames: credential.cookieNames,
        verifiedAt: verification.ok
          ? verification.verifiedAt || new Date()
          : credential.verifiedAt || null,
        lastValidationError: verification.ok
          ? null
          : verification.error || 'Douyin Cookie verification failed',
      });
      return verification;
    }

    const configuredCookie = this.getConfiguredCookie();
    if (configuredCookie) {
      const normalized = this.normalizeCookieHeader(configuredCookie);
      return this.verifyNormalizedCookie(
        normalized.cookieHeader,
        normalized.cookieNames,
        roomId
      );
    }

    throw new DouyinCredentialError('No Douyin Cookie has been saved');
  }

  async clear(): Promise<void> {
    await this.credentialRepository.clear();
  }

  async startBrowserLogin(roomId?: string): Promise<DouyinBrowserLoginStatus> {
    this.pruneBrowserLoginSessions();

    const now = new Date();
    const session: DouyinBrowserLoginSession = {
      id: randomUUID(),
      status: 'initializing',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + BROWSER_LOGIN_TTL_MS),
    };

    session.expireTimer = setTimeout(() => {
      void this.expireBrowserLoginSession(session.id);
    }, BROWSER_LOGIN_TTL_MS);

    this.browserLoginSessions.set(session.id, session);
    void this.prepareBrowserLoginSession(session, roomId);

    return this.serializeBrowserLoginSession(session);
  }

  async getBrowserLoginStatus(
    sessionId: string
  ): Promise<DouyinBrowserLoginStatus> {
    const session = this.getBrowserLoginSession(sessionId);
    if (
      session.status === 'waiting' ||
      session.status === 'verification_required' ||
      session.status === 'initializing'
    ) {
      await this.checkBrowserLoginSession(session);
    }
    return this.serializeBrowserLoginSession(session);
  }

  async getBrowserLoginScreenshot(sessionId: string): Promise<Buffer> {
    const session = this.getBrowserLoginSession(sessionId);
    if (!session.page || session.status === 'failed') {
      throw new DouyinCredentialError('Douyin login page is not ready', 409);
    }

    const screenshot = await session.page.screenshot({
      type: 'png',
      fullPage: false,
    });
    session.updatedAt = new Date();
    return Buffer.from(screenshot);
  }

  async interactWithBrowserLogin(
    sessionId: string,
    interaction: DouyinBrowserLoginInteraction
  ): Promise<DouyinBrowserLoginStatus> {
    if (
      !interaction ||
      !['select_verification_method', 'submit_verification_code'].includes(
        interaction.type
      )
    ) {
      throw new DouyinCredentialError(
        'Douyin verification interaction type is invalid'
      );
    }

    const session = this.getBrowserLoginSession(sessionId);
    if (!session.page || session.status !== 'verification_required') {
      throw new DouyinCredentialError('Douyin verification is not ready', 409);
    }

    this.assertDouyinLoginPage(session.page.url());

    if (interaction.type === 'select_verification_method') {
      const label = DOUYIN_VERIFICATION_METHOD_LABELS[interaction.method];
      if (!label) {
        throw new DouyinCredentialError(
          'Douyin verification method is invalid'
        );
      }

      const selected = await this.clickVisibleElementByText(session.page, [
        label,
      ]);
      if (!selected) {
        throw new DouyinCredentialError(
          'Selected Douyin verification method is not available',
          409
        );
      }

      session.verification = {
        stage: 'processing',
        method: interaction.method,
        availableMethods:
          session.verification?.availableMethods ||
          (Object.keys(
            DOUYIN_VERIFICATION_METHOD_LABELS
          ) as DouyinVerificationMethod[]),
      };
      await this.sleep(500);
      session.verification = {
        ...session.verification,
        stage:
          interaction.method === 'receive_sms'
            ? 'awaiting_code'
            : 'awaiting_external',
        prompt:
          interaction.method === 'receive_sms'
            ? '验证码已发送到绑定手机，请在前端输入。'
            : (await this.getBrowserLoginVerificationPrompt(session.page)) ||
              (interaction.method === 'face'
                ? '请在手机上完成刷脸验证，完成后系统会自动继续。'
                : '请使用绑定手机按抖音提示发送短信，完成后系统会自动继续。'),
      };
    } else if (interaction.type === 'submit_verification_code') {
      if (!/^\d{4,8}$/.test(interaction.code || '')) {
        throw new DouyinCredentialError(
          'Douyin verification code must contain 4 to 8 digits'
        );
      }

      if (session.verification?.method !== 'receive_sms') {
        throw new DouyinCredentialError(
          'SMS verification has not been selected',
          409
        );
      }

      const filled = await this.fillVisibleVerificationCode(
        session.page,
        interaction.code
      );
      if (!filled) {
        throw new DouyinCredentialError(
          'Douyin verification code input is not available',
          409
        );
      }

      const submitted = await this.clickVisibleElementByText(
        session.page,
        DOUYIN_VERIFICATION_SUBMIT_LABELS
      );
      if (!submitted) {
        await session.page.keyboard.press('Enter');
      }
      session.verification = {
        ...session.verification,
        stage: 'processing',
      };
      await this.sleep(500);
      await this.checkBrowserLoginSession(session);
      if (
        session.status === 'verification_required' &&
        session.verification?.method === 'receive_sms'
      ) {
        session.verification = {
          ...session.verification,
          stage: 'awaiting_code',
          prompt:
            (await this.getBrowserLoginVerificationPrompt(session.page)) ||
            session.verification.prompt,
        };
      }
    }

    session.updatedAt = new Date();
    return this.serializeBrowserLoginSession(session);
  }

  async cancelBrowserLogin(sessionId: string): Promise<void> {
    const session = this.getBrowserLoginSession(sessionId);
    session.status = 'cancelled';
    session.updatedAt = new Date();
    await this.closeBrowserLoginSession(session);
    this.browserLoginSessions.delete(sessionId);
  }

  async getCookieHeader(): Promise<string> {
    const credential = await this.credentialRepository.findLatest();
    return credential?.cookieHeader || '';
  }

  normalizeCookieHeader(rawCookie: string): NormalizedDouyinCookie {
    const extracted = this.extractCookieHeader(rawCookie);
    const cookies = new Map<string, string>();

    for (const part of extracted.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }

      const separator = trimmed.indexOf('=');
      if (separator <= 0) {
        continue;
      }

      const name = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!name || COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase())) {
        continue;
      }
      if (IGNORED_DOUYIN_COOKIE_NAMES.has(name)) {
        continue;
      }
      if (hasInvalidCookieNameCharacter(name)) {
        continue;
      }

      cookies.set(name, value);
    }

    if (cookies.size === 0) {
      throw new DouyinCredentialError('Invalid Douyin Cookie');
    }

    return {
      cookieHeader: Array.from(cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
      cookieNames: Array.from(cookies.keys()).sort(),
    };
  }

  private async verifyNormalizedCookie(
    cookieHeader: string,
    cookieNames: string[],
    roomId?: string
  ): Promise<DouyinCookieVerification> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    try {
      const webRid = roomId?.trim() || '';
      const url = webRid
        ? `https://live.douyin.com/${encodeURIComponent(webRid)}`
        : 'https://live.douyin.com/';
      const response = await fetch(url, {
        headers: {
          'User-Agent': this.getUserAgent(),
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          Referer: webRid ? `https://live.douyin.com/${webRid}` : url,
          Cookie: cookieHeader,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const captchaDetected = this.isCaptchaPage(text);

      if (!response.ok) {
        return {
          ok: false,
          cookieNames,
          statusCode: response.status,
          captchaDetected,
          error: `Douyin returned HTTP ${response.status}`,
        };
      }

      if (captchaDetected) {
        return {
          ok: false,
          cookieNames,
          statusCode: response.status,
          captchaDetected: true,
          error: 'Douyin returned a captcha page',
        };
      }

      if (!text.trim()) {
        return {
          ok: false,
          cookieNames,
          statusCode: response.status,
          captchaDetected: false,
          error: 'Douyin returned an empty verification response',
        };
      }

      if (webRid && !this.hasRoomInfoMarker(text)) {
        return {
          ok: false,
          cookieNames,
          statusCode: response.status,
          captchaDetected: false,
          error: 'Douyin room info was not found in verification response',
        };
      }

      return {
        ok: true,
        cookieNames,
        statusCode: response.status,
        captchaDetected: false,
        verifiedAt: new Date(),
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'Douyin Cookie verification timed out'
          : error instanceof Error
          ? error.message
          : 'Douyin Cookie verification failed';
      this.logger?.warn('Failed to verify Douyin Cookie', { error: message });
      return {
        ok: false,
        cookieNames,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async prepareBrowserLoginSession(
    session: DouyinBrowserLoginSession,
    roomId?: string
  ): Promise<void> {
    try {
      const browserTarget = await this.createBrowserLoginTarget();
      session.browser = browserTarget.browser;
      session.browserContext = browserTarget.browserContext;
      session.page = browserTarget.page;
      session.ownsBrowser = browserTarget.ownsBrowser;

      await session.page.setViewport({
        width: 390,
        height: 760,
        deviceScaleFactor: 2,
        isMobile: true,
      });
      await session.page.setUserAgent(this.getUserAgent());

      const webRid = roomId?.trim();
      const url = webRid
        ? `https://live.douyin.com/${encodeURIComponent(webRid)}`
        : 'https://www.douyin.com/';

      await this.navigateToDouyinLoginPage(session.page, url);
      await this.openDouyinLoginPanel(session.page);

      session.status = 'waiting';
      session.updatedAt = new Date();
      session.pollTimer = setInterval(() => {
        void this.checkBrowserLoginSession(session);
      }, BROWSER_LOGIN_POLL_MS);
      await this.checkBrowserLoginSession(session);
    } catch (error) {
      session.status = 'failed';
      session.error = error instanceof Error ? error.message : String(error);
      session.updatedAt = new Date();
      this.logger?.error('Failed to start Douyin browser login', {
        sessionId: session.id,
        error: session.error,
      });
      await this.closeBrowserLoginSession(session);
    }
  }

  private async checkBrowserLoginSession(
    session: DouyinBrowserLoginSession
  ): Promise<void> {
    if (
      !session.page ||
      session.status === 'authenticated' ||
      session.status === 'failed' ||
      session.status === 'expired' ||
      session.status === 'cancelled'
    ) {
      return;
    }

    if (Date.now() >= session.expiresAt.getTime()) {
      await this.expireBrowserLoginSession(session.id);
      return;
    }

    try {
      const cookies = session.browserContext
        ? await session.browserContext.cookies()
        : session.browser
        ? await session.browser.cookies()
        : await session.page.cookies();
      if (!this.hasAuthenticatedDouyinCookies(cookies)) {
        const verificationRequired =
          session.status === 'verification_required' ||
          (await this.isIdentityVerificationPage(session.page));
        session.status = verificationRequired
          ? 'verification_required'
          : 'waiting';
        if (verificationRequired && !session.verification) {
          session.verification = {
            stage: 'choose_method',
            availableMethods: Object.keys(
              DOUYIN_VERIFICATION_METHOD_LABELS
            ) as DouyinVerificationMethod[],
          };
        } else if (
          verificationRequired &&
          session.verification?.stage === 'awaiting_external'
        ) {
          session.verification.prompt =
            (await this.getBrowserLoginVerificationPrompt(session.page)) ||
            session.verification.prompt;
        } else if (!verificationRequired) {
          session.verification = undefined;
        }
        session.updatedAt = new Date();
        return;
      }

      const normalized = this.buildCookieHeaderFromBrowserCookies(cookies);
      const saved = await this.credentialRepository.saveCredential({
        cookieHeader: normalized.cookieHeader,
        cookieNames: normalized.cookieNames,
        verifiedAt: new Date(),
        lastValidationError: null,
      });

      session.status = 'authenticated';
      session.cookieNames = saved.cookieNames;
      session.verifiedAt = saved.verifiedAt || new Date();
      session.verification = undefined;
      session.updatedAt = new Date();
      await this.closeBrowserLoginSession(session);
    } catch (error) {
      if (this.isTransientBrowserNavigationError(error)) {
        session.updatedAt = new Date();
        this.logger?.debug('Douyin login page is still navigating', {
          sessionId: session.id,
        });
        return;
      }
      session.status = 'failed';
      session.error =
        error instanceof Error
          ? error.message
          : 'Failed to read Douyin browser Cookie';
      session.updatedAt = new Date();
      this.logger?.error('Failed to complete Douyin browser login', {
        sessionId: session.id,
        error: session.error,
      });
      await this.closeBrowserLoginSession(session);
    }
  }

  private async isIdentityVerificationPage(page: Page): Promise<boolean> {
    const text = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      return (doc.body?.innerText || doc.body?.textContent || '').trim();
    });
    return isDouyinIdentityVerificationText(text);
  }

  private async getBrowserLoginVerificationPrompt(
    page: Page
  ): Promise<string | undefined> {
    const prompt = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const normalize = (value: unknown) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim();
      const bodyText = normalize(
        doc.body?.innerText || doc.body?.textContent || ''
      );
      const identityIndex = bodyText.search(/身份验证|安全验证/);
      return identityIndex >= 0
        ? bodyText.slice(identityIndex, identityIndex + 600)
        : '';
    });
    return prompt || undefined;
  }

  private async clickVisibleElementByText(
    page: Page,
    labels: readonly string[]
  ): Promise<boolean> {
    for (const label of labels) {
      try {
        await page
          .locator(`::-p-text(${label})`)
          .setTimeout(1500)
          .setVisibility('visible')
          .click();
        return true;
      } catch {
        // Try the next semantic label.
      }
    }
    return false;
  }

  private async fillVisibleVerificationCode(
    page: Page,
    code: string
  ): Promise<boolean> {
    try {
      await page
        .locator(
          '::-p-xpath((//input[contains(@placeholder,"验证码") or contains(@aria-label,"验证码")])[last()])'
        )
        .setTimeout(3000)
        .setVisibility('visible')
        .fill(code);
      return true;
    } catch {
      return false;
    }
  }

  private assertDouyinLoginPage(pageUrl: string): void {
    let hostname = '';
    try {
      hostname = new URL(pageUrl).hostname.toLowerCase();
    } catch {
      throw new DouyinCredentialError('Douyin login page URL is invalid', 409);
    }

    if (hostname !== 'douyin.com' && !hostname.endsWith('.douyin.com')) {
      throw new DouyinCredentialError(
        'Browser interaction is restricted to Douyin pages',
        409
      );
    }
  }

  private async openDouyinLoginPanel(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.sleep(attempt === 0 ? 2000 : 1000);
      if (
        await this.clickVisibleElementByText(page, [
          '扫码登录',
          '立即登录',
          '登录',
        ])
      ) {
        await this.sleep(2000);
        return;
      }
    }
  }

  private async navigateToDouyinLoginPage(
    page: Page,
    url: string
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        return;
      } catch (error) {
        if (attempt === 1 || !this.isTransientBrowserNavigationError(error)) {
          throw error;
        }
        await this.sleep(1000);
      }
    }
  }

  private isTransientBrowserNavigationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /execution context was destroyed|navigating frame was detached|frame was detached|cannot find context with specified id/i.test(
      message
    );
  }

  private buildCookieHeaderFromBrowserCookies(
    browserCookies: Cookie[]
  ): NormalizedDouyinCookie {
    const cookieHeader = browserCookies
      .filter(cookie => this.isByteDanceCookieDomain(cookie.domain))
      .filter(cookie => cookie.name && cookie.value !== undefined)
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');

    return this.normalizeCookieHeader(cookieHeader);
  }

  private hasAuthenticatedDouyinCookies(browserCookies: Cookie[]): boolean {
    return browserCookies
      .filter(cookie => this.isByteDanceCookieDomain(cookie.domain))
      .some(cookie =>
        AUTHENTICATED_COOKIE_NAMES.has(cookie.name.toLowerCase())
      );
  }

  private isByteDanceCookieDomain(domain: string): boolean {
    return BYTE_DANCE_COOKIE_DOMAIN_PATTERN.test(domain.replace(/^\./, ''));
  }

  private getBrowserLoginSession(sessionId: string): DouyinBrowserLoginSession {
    const session = this.browserLoginSessions.get(sessionId);
    if (!session) {
      throw new DouyinCredentialError('Douyin login session not found', 404);
    }
    return session;
  }

  private serializeBrowserLoginSession(
    session: DouyinBrowserLoginSession
  ): DouyinBrowserLoginStatus {
    return {
      sessionId: session.id,
      status: session.status,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      updatedAt: session.updatedAt,
      screenshotUpdatedAt:
        session.page &&
        (session.status === 'initializing' ||
          session.status === 'waiting' ||
          session.status === 'verification_required')
          ? new Date()
          : undefined,
      cookieNames: session.cookieNames,
      verifiedAt: session.verifiedAt,
      error: session.error,
      verification: session.verification,
    };
  }

  private async expireBrowserLoginSession(sessionId: string): Promise<void> {
    const session = this.browserLoginSessions.get(sessionId);
    if (!session) {
      return;
    }
    if (
      session.status === 'initializing' ||
      session.status === 'waiting' ||
      session.status === 'verification_required'
    ) {
      session.status = 'expired';
      session.updatedAt = new Date();
    }
    await this.closeBrowserLoginSession(session);
  }

  private async closeBrowserLoginSession(
    session: DouyinBrowserLoginSession
  ): Promise<void> {
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = undefined;
    }
    if (session.expireTimer) {
      clearTimeout(session.expireTimer);
      session.expireTimer = undefined;
    }
    if (session.browserContext) {
      try {
        await session.browserContext.close();
      } catch (error) {
        this.logger?.debug('Failed to close Douyin login browser context', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      session.browserContext = undefined;
    }
    if (session.browser) {
      try {
        if (session.ownsBrowser) {
          await session.browser.close();
        } else {
          await session.browser.disconnect();
        }
      } catch (error) {
        this.logger?.debug('Failed to release Douyin login browser', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      session.browser = undefined;
      session.page = undefined;
      session.ownsBrowser = undefined;
    }
  }

  private pruneBrowserLoginSessions(): void {
    const removableStates = new Set<DouyinBrowserLoginState>([
      'authenticated',
      'expired',
      'failed',
      'cancelled',
    ]);
    const cutoff = Date.now() - BROWSER_LOGIN_TTL_MS;
    for (const [sessionId, session] of this.browserLoginSessions.entries()) {
      if (
        removableStates.has(session.status) &&
        session.updatedAt.getTime() < cutoff
      ) {
        this.browserLoginSessions.delete(sessionId);
      }
    }
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

  private async createBrowserLoginTarget(): Promise<{
    browser: Browser;
    browserContext: BrowserContext;
    page: Page;
    ownsBrowser: boolean;
  }> {
    const puppeteer = await this.importPuppeteer();
    const remoteEndpoint = this.getBrowserEndpoint();
    let browser: Browser;
    let ownsBrowser = false;

    if (remoteEndpoint) {
      const connection = await this.resolveRemoteBrowserConnection(
        remoteEndpoint
      );
      browser = await puppeteer.connect(connection);
    } else {
      const executablePath = this.resolveChromiumExecutablePath();
      if (!executablePath) {
        throw new DouyinCredentialError(
          'Browser endpoint is not configured and Chromium executable was not found.',
          500
        );
      }

      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: this.buildChromiumLaunchArgs(),
      });
      ownsBrowser = true;
    }

    const browserContext = await browser.createBrowserContext();
    const page = await browserContext.newPage();
    return { browser, browserContext, page, ownsBrowser };
  }

  private getBrowserEndpoint(): string {
    return (
      process.env.DOUYIN_BROWSER_ENDPOINT?.trim() ||
      process.env.DOUYIN_BROWSER_WS_ENDPOINT?.trim() ||
      process.env.BROWSER_WS_ENDPOINT?.trim() ||
      ''
    );
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
    const version = JSON.parse(response) as { webSocketDebuggerUrl?: string };

    if (!version.webSocketDebuggerUrl) {
      throw new DouyinCredentialError(
        'Browser endpoint did not return a WebSocket debugger URL',
        500
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
                new DouyinCredentialError(
                  `Browser endpoint returned HTTP ${
                    response.statusCode
                  }: ${body.slice(0, 120)}`,
                  500
                )
              );
              return;
            }
            resolve(body);
          });
        }
      );

      request.setTimeout(5000, () => {
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
      '--disable-gpu',
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

  private extractCookieHeader(rawCookie: string): string {
    const trimmed = rawCookie.trim();
    if (!trimmed) {
      throw new DouyinCredentialError('Douyin Cookie is required');
    }

    const cookieLine = trimmed
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => /^cookie\s*:/i.test(line));

    return (cookieLine || trimmed)
      .replace(/^cookie\s*:\s*/i, '')
      .replace(/\r?\n/g, '; ');
  }

  private getConfiguredCookie(): string {
    return getConfig().platforms?.douyin?.cookie?.trim() || '';
  }

  private getUserAgent(): string {
    return (
      getConfig().platforms?.douyin?.userAgent?.trim() ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    );
  }

  private isCaptchaPage(html: string): boolean {
    const title = html.match(/<title>(.*?)<\/title>/i)?.[1] || '';
    return (
      /验证码中间页|安全验证|captcha|verify/i.test(title) ||
      /captcha\/index\.js|secsdk-captcha|argus-csp-token/i.test(html)
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export function isDouyinIdentityVerificationText(text: string): boolean {
  return (
    /身份验证|安全验证/.test(text) &&
    /短信验证码|刷脸验证|本人操作|验证方式/.test(text)
  );
}
