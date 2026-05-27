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
import type { Browser, Cookie, Page } from 'puppeteer-core';
import { DouyinCredentialRepository } from '../repository/douyin-credential.repository';
import { getConfig } from '../config/loader';

const VERIFY_TIMEOUT_MS = 15000;
const BROWSER_LOGIN_TTL_MS = 5 * 60 * 1000;
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
const AUTHENTICATED_COOKIE_NAMES = new Set([
  'sessionid',
  'sid_guard',
  'sid_tt',
  'uid_tt',
  'passport_auth_status',
]);
const BYTE_DANCE_COOKIE_DOMAIN_PATTERN =
  /(^|\.)((douyin|iesdouyin|amemv|bytedance|snssdk|toutiao)\.com)$/i;

export type DouyinBrowserLoginState =
  | 'initializing'
  | 'waiting'
  | 'authenticated'
  | 'expired'
  | 'failed'
  | 'cancelled';

interface DouyinBrowserLoginSession {
  id: string;
  status: DouyinBrowserLoginState;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  browser?: Browser;
  page?: Page;
  pollTimer?: NodeJS.Timeout;
  expireTimer?: NodeJS.Timeout;
  cookieNames?: string[];
  verifiedAt?: Date;
  error?: string;
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
    if (session.status === 'waiting' || session.status === 'initializing') {
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
      if (/[\s;,\u0000-\u001f\u007f]/.test(name)) {
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
      const executablePath = this.resolveChromiumExecutablePath();
      if (!executablePath) {
        throw new DouyinCredentialError(
          'Chromium executable not found. Install chromium or set CHROMIUM_PATH.',
          500
        );
      }

      const { launch } = await this.importPuppeteer();
      const browser = await launch({
        executablePath,
        headless: true,
        args: this.buildChromiumLaunchArgs(),
      });
      const page = await browser.newPage();
      session.browser = browser;
      session.page = page;

      await page.setViewport({
        width: 390,
        height: 760,
        deviceScaleFactor: 2,
        isMobile: true,
      });
      await page.setUserAgent(this.getUserAgent());

      const webRid = roomId?.trim();
      const url = webRid
        ? `https://live.douyin.com/${encodeURIComponent(webRid)}`
        : 'https://www.douyin.com/';

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await this.sleep(2000);
      await this.openDouyinLoginPanel(page);

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
      const cookies = session.browser
        ? await session.browser.cookies()
        : await session.page.cookies();
      if (!this.hasAuthenticatedDouyinCookies(cookies)) {
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
      session.updatedAt = new Date();
      await this.closeBrowserLoginSession(session);
    } catch (error) {
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

  private async openDouyinLoginPanel(page: Page): Promise<void> {
    await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const selectors = [
        '[data-e2e="login-button"]',
        '[data-e2e*="login"]',
        '[class*="login"]',
        'button',
        'a',
        'div',
        'span',
      ];
      const elements = selectors.flatMap(selector =>
        Array.from(doc.querySelectorAll(selector))
      );
      const uniqueElements = Array.from(new Set(elements));
      const loginElement = uniqueElements.find(element => {
        const node = element as any;
        const text = (node.innerText || node.textContent || '').trim();
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          text.length > 0 &&
          text.length <= 20 &&
          /登录|扫码登录|立即登录/.test(text)
        );
      });

      (loginElement as any)?.click();
    });
    await this.sleep(2000);
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
      .some(cookie => AUTHENTICATED_COOKIE_NAMES.has(cookie.name.toLowerCase()));
  }

  private isByteDanceCookieDomain(domain: string): boolean {
    return BYTE_DANCE_COOKIE_DOMAIN_PATTERN.test(domain.replace(/^\./, ''));
  }

  private getBrowserLoginSession(
    sessionId: string
  ): DouyinBrowserLoginSession {
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
        (session.status === 'initializing' || session.status === 'waiting')
          ? new Date()
          : undefined,
      cookieNames: session.cookieNames,
      verifiedAt: session.verifiedAt,
      error: session.error,
    };
  }

  private async expireBrowserLoginSession(sessionId: string): Promise<void> {
    const session = this.browserLoginSessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.status === 'initializing' || session.status === 'waiting') {
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
    if (session.browser) {
      try {
        await session.browser.close();
      } catch (error) {
        this.logger?.debug('Failed to close Douyin login browser', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      session.browser = undefined;
      session.page = undefined;
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
