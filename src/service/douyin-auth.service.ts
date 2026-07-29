import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { randomUUID } from 'crypto';
import { DouyinAuthState } from '../interface';
import {
  DouyinCredentialOperation,
  DouyinCredentialRepository,
  DouyinCredentialTransition,
} from '../repository/douyin-credential.repository';
import {
  DouyinBrowserLoginTarget,
  DouyinBrowserProfileService,
  DouyinProfileChallenge,
  DouyinProfileProbeResult,
} from './douyin-browser-profile.service';

const BROWSER_LOGIN_TTL_MS = 10 * 60 * 1000;
const BROWSER_LOGIN_POLL_MS = 2_000;
const VERIFICATION_METHODS: DouyinVerificationMethod[] = [
  'receive_sms',
  'face',
  'send_sms',
];

export type DouyinBrowserLoginState =
  | 'initializing'
  | 'waiting'
  | 'verification_required'
  | 'validating'
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
  challenge: DouyinProfileChallenge;
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
  roomId?: string;
  target?: DouyinBrowserLoginTarget;
  pollTimer?: NodeJS.Timeout;
  expireTimer?: NodeJS.Timeout;
  preparePromise?: Promise<void>;
  checkPromise?: Promise<void>;
  pageOperation?: Promise<void>;
  cookieNames?: string[];
  verifiedAt?: Date;
  error?: string;
  verification?: DouyinBrowserLoginVerification;
  operation?: DouyinCredentialOperation;
}

export class DouyinCredentialError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'DouyinCredentialError';
  }
}

export interface DouyinAuthStatus {
  state: DouyinAuthState;
  isAuthenticated: boolean;
  source?: 'browser_profile';
  browserHealthy?: boolean;
  profilePersistent?: boolean;
  cookieNames?: string[];
  validatedAt?: Date | null;
  lastValidatedAt?: Date | null;
  verifiedAt?: Date | null;
  stateChangedAt?: Date | null;
  updatedAt?: Date;
  authExpiresAt?: Date | null;
  lastValidationCode?: string | null;
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

  @Inject()
  private browserProfileService: DouyinBrowserProfileService;

  @Logger()
  private logger: ILogger;

  private browserLoginSessions = new Map<string, DouyinBrowserLoginSession>();
  private activeOperations = new Set<string>();
  private reconciliationPromise?: Promise<void>;
  private logoutInProgress = false;

  async getStatus(): Promise<DouyinAuthStatus> {
    let credential = await this.credentialRepository.findLatest();
    if (!credential) {
      return {
        state: 'unconfigured',
        isAuthenticated: false,
        browserHealthy: true,
        profilePersistent: true,
      };
    }

    if (
      credential.state === 'validating' &&
      !this.isOperationActive({
        id: credential.operationId || '',
        generation: credential.generation || 0,
      })
    ) {
      await this.reconcileProfileState();
      credential = await this.credentialRepository.findLatest();
    } else if (
      credential.state === 'valid' &&
      credential.authExpiresAt &&
      credential.authExpiresAt.getTime() <= Date.now()
    ) {
      // This is the earliest persistent expiry across several authentication-
      // related cookies, including auxiliary passport cookies. Treat it as a
      // revalidation hint; only the account endpoint may expire the session.
      await this.reconcileProfileState();
      credential = await this.credentialRepository.findLatest();
    }

    if (!credential) {
      return {
        state: 'unconfigured',
        isAuthenticated: false,
        browserHealthy: true,
        profilePersistent: true,
      };
    }

    const state = credential.state || 'unknown';
    return {
      state,
      isAuthenticated: state === 'valid',
      source: 'browser_profile',
      browserHealthy: credential.lastValidationCode !== 'BROWSER_UNAVAILABLE',
      profilePersistent: true,
      cookieNames: credential.cookieNames,
      validatedAt: credential.verifiedAt,
      lastValidatedAt: credential.verifiedAt,
      verifiedAt: credential.verifiedAt,
      stateChangedAt: credential.stateChangedAt,
      updatedAt: credential.updatedAt,
      authExpiresAt: credential.authExpiresAt,
      lastValidationCode: credential.lastValidationCode,
      lastValidationError: credential.lastValidationError,
    };
  }

  /**
   * Raw Cookie import is intentionally retired. A flattened header cannot
   * preserve the browser storage and fingerprint that Douyin binds to a login.
   */
  async saveCookie(
    _rawCookie?: string,
    _options?: { verify?: boolean; roomId?: string }
  ): Promise<never> {
    void _rawCookie;
    void _options;
    throw new DouyinCredentialError(
      'Manual Douyin Cookie import has been retired. Use browser login so the complete browser profile can be persisted.',
      410
    );
  }

  async verifyCookie(
    rawCookie?: string,
    roomId?: string
  ): Promise<DouyinCookieVerification> {
    if (rawCookie?.trim()) {
      throw new DouyinCredentialError(
        'Manual Douyin Cookie verification has been retired. Verify the persisted browser profile instead.',
        410
      );
    }

    if (this.logoutInProgress) {
      throw new DouyinCredentialError('Douyin logout is in progress', 409);
    }

    const operation = await this.beginOperation({
      lastValidationCode: null,
      lastValidationError: null,
    });

    let target: DouyinBrowserLoginTarget | undefined;
    try {
      target = await this.browserProfileService.createLoginTarget(roomId);
      const probe = await this.browserProfileService.probe(target.page, roomId);
      const persisted = await this.persistProbe(probe, operation, true);
      return persisted
        ? this.toVerification(probe)
        : {
            ok: false,
            cookieNames: [],
            error: 'Douyin account validation was superseded',
          };
    } catch (error) {
      const message = this.errorMessage(error);
      await this.transitionForOperation(
        operation,
        'unknown',
        {
          lastValidationCode: 'BROWSER_UNAVAILABLE',
          lastValidationError: message,
        },
        true
      );
      return {
        ok: false,
        cookieNames: [],
        error: message,
      };
    } finally {
      this.releaseOperation(operation);
      if (target) {
        await this.browserProfileService.closeTarget(target);
      }
    }
  }

  async clear(): Promise<void> {
    if (this.logoutInProgress) {
      throw new DouyinCredentialError(
        'Douyin logout is already in progress',
        409
      );
    }
    this.logoutInProgress = true;
    let operation: DouyinCredentialOperation | undefined;

    try {
      operation = await this.beginOperation({
        lastValidationCode: null,
        lastValidationError: null,
      });
      const sessions = Array.from(this.browserLoginSessions.values());
      for (const session of sessions) {
        session.status = 'cancelled';
        session.updatedAt = new Date();
        this.releaseOperation(session.operation);
        await this.closeBrowserLoginSession(session, true);
      }
      this.browserLoginSessions.clear();

      await this.browserProfileService.logout();
      await this.transitionForOperation(
        operation,
        'expired',
        {
          cookieNames: [],
          verifiedAt: null,
          authExpiresAt: null,
          lastValidationCode: 'SESSION_EXPIRED',
          lastValidationError: 'Signed out by user',
        },
        true
      );
    } catch (error) {
      const message = this.errorMessage(error);
      if (operation) {
        await this.transitionForOperation(
          operation,
          'unknown',
          {
            cookieNames: [],
            verifiedAt: null,
            authExpiresAt: null,
            lastValidationCode: 'BROWSER_UNAVAILABLE',
            lastValidationError: message,
          },
          true
        );
      }
      throw error;
    } finally {
      this.releaseOperation(operation);
      this.logoutInProgress = false;
    }
  }

  async startBrowserLogin(roomId?: string): Promise<DouyinBrowserLoginStatus> {
    if (this.logoutInProgress) {
      throw new DouyinCredentialError('Douyin logout is in progress', 409);
    }
    this.pruneBrowserLoginSessions();
    const activeSession = Array.from(this.browserLoginSessions.values()).find(
      session => this.isActiveSession(session.status)
    );
    if (activeSession) {
      await this.checkBrowserLoginSession(activeSession);
      if (this.isActiveSession(activeSession.status)) {
        return this.serializeBrowserLoginSession(activeSession);
      }
    }

    const now = new Date();
    const session: DouyinBrowserLoginSession = {
      id: randomUUID(),
      status: 'initializing',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + BROWSER_LOGIN_TTL_MS),
      roomId: roomId?.trim() || undefined,
    };
    session.expireTimer = setTimeout(() => {
      void this.expireBrowserLoginSession(session.id).catch(error => {
        this.logger?.warn('Failed to expire Douyin browser login', {
          sessionId: session.id,
          error: this.errorMessage(error),
        });
      });
    }, BROWSER_LOGIN_TTL_MS);
    this.browserLoginSessions.set(session.id, session);

    try {
      session.operation = await this.beginOperation({
        lastValidationCode: null,
        lastValidationError: null,
      });
    } catch (error) {
      if (session.expireTimer) {
        clearTimeout(session.expireTimer);
      }
      this.browserLoginSessions.delete(session.id);
      throw error;
    }
    const preparePromise = this.prepareBrowserLoginSession(session);
    session.preparePromise = preparePromise;
    const clearPreparePromise = () => {
      if (session.preparePromise === preparePromise) {
        session.preparePromise = undefined;
      }
    };
    void preparePromise.then(clearPreparePromise, clearPreparePromise);
    return this.serializeBrowserLoginSession(session);
  }

  async getBrowserLoginStatus(
    sessionId: string
  ): Promise<DouyinBrowserLoginStatus> {
    const session = this.getBrowserLoginSession(sessionId);
    if (this.isActiveSession(session.status)) {
      await this.checkBrowserLoginSession(session);
    }
    return this.serializeBrowserLoginSession(session);
  }

  async getBrowserLoginScreenshot(sessionId: string): Promise<Buffer> {
    const session = this.getBrowserLoginSession(sessionId);
    const page = session.target?.page;
    if (!page || page.isClosed() || session.status === 'failed') {
      throw new DouyinCredentialError('Douyin login page is not ready', 409);
    }
    const screenshot = await page.screenshot({
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
    const session = this.getBrowserLoginSession(sessionId);
    let shouldCheck = false;

    await this.withBrowserPageOperation(session, async () => {
      const page = session.target?.page;
      if (
        !page ||
        page.isClosed() ||
        session.status !== 'verification_required'
      ) {
        throw new DouyinCredentialError(
          'Douyin verification is not ready',
          409
        );
      }

      if (interaction?.type === 'select_verification_method') {
        if (!VERIFICATION_METHODS.includes(interaction.method)) {
          throw new DouyinCredentialError(
            'Douyin verification method is invalid'
          );
        }
        if (session.verification?.challenge !== 'second_verification') {
          throw new DouyinCredentialError(
            'Selected Douyin verification method is not available',
            409
          );
        }
        const availableMethods =
          await this.browserProfileService.getAvailableVerificationMethods(
            page
          );
        if (!availableMethods.includes(interaction.method)) {
          session.verification = {
            challenge: 'second_verification',
            stage: 'choose_method',
            availableMethods,
            prompt: '抖音验证页面已更新，请重新选择可用的验证方式。',
          };
          session.updatedAt = new Date();
          throw new DouyinCredentialError(
            'Selected Douyin verification method is not available',
            409
          );
        }
        const selected =
          await this.browserProfileService.selectVerificationMethod(
            page,
            interaction.method
          );
        if (!selected) {
          session.verification = {
            challenge: 'second_verification',
            stage: 'choose_method',
            availableMethods:
              await this.browserProfileService.getAvailableVerificationMethods(
                page
              ),
            prompt: '抖音验证页面已更新，请重新选择可用的验证方式。',
          };
          session.updatedAt = new Date();
          throw new DouyinCredentialError(
            'Selected Douyin verification method is not available',
            409
          );
        }
        session.verification = {
          challenge: 'second_verification',
          stage:
            interaction.method === 'receive_sms'
              ? 'awaiting_code'
              : 'awaiting_external',
          method: interaction.method,
          availableMethods,
          prompt:
            interaction.method === 'receive_sms'
              ? '验证码已发送到绑定手机，请在这里输入。'
              : interaction.method === 'face'
              ? '请在手机端完成刷脸认证，系统会自动继续。'
              : '请按抖音提示使用绑定手机发送短信，系统会自动继续。',
        };
      } else if (interaction?.type === 'submit_verification_code') {
        if (session.verification?.method !== 'receive_sms') {
          throw new DouyinCredentialError(
            'SMS verification has not been selected',
            409
          );
        }
        const submitted =
          await this.browserProfileService.submitVerificationCode(
            page,
            interaction.code
          );
        if (!submitted) {
          throw new DouyinCredentialError(
            'Douyin verification code input is not available',
            409
          );
        }
        session.verification = {
          ...session.verification,
          stage: 'processing',
        };
        shouldCheck = true;
      } else {
        throw new DouyinCredentialError(
          'Douyin verification interaction type is invalid'
        );
      }
      session.updatedAt = new Date();
    });

    if (shouldCheck) {
      await this.sleep(500);
      await this.checkBrowserLoginSession(session);
    }

    session.updatedAt = new Date();
    return this.serializeBrowserLoginSession(session);
  }

  async cancelBrowserLogin(sessionId: string): Promise<void> {
    const session = this.getBrowserLoginSession(sessionId);
    session.status = 'cancelled';
    session.updatedAt = new Date();
    await this.invalidateOperation('unknown', {
      lastValidationCode: 'TRANSIENT_ERROR',
      lastValidationError: 'Douyin browser login was cancelled',
    });
    this.releaseOperation(session.operation);
    await this.closeBrowserLoginSession(session, true);
    this.browserLoginSessions.delete(sessionId);
    await this.reconcileProfileState();
  }

  /**
   * The anonymous resolver calls this only when the persisted browser fallback
   * itself reaches an explicit challenge. Transient public failures never
   * overwrite a previously valid account state.
   */
  async markRuntimeChallenge(error?: string): Promise<void> {
    if (this.activeOperations.size > 0 || this.logoutInProgress) {
      return;
    }
    await this.invalidateOperation('challenged', {
      lastValidationCode: 'CAPTCHA_REQUIRED',
      lastValidationError:
        error || 'Douyin browser profile requires verification',
    });
  }

  async markRuntimeExpired(error?: string): Promise<void> {
    if (this.activeOperations.size > 0 || this.logoutInProgress) {
      return;
    }
    await this.invalidateOperation('expired', {
      verifiedAt: null,
      authExpiresAt: null,
      lastValidationCode: 'SESSION_EXPIRED',
      lastValidationError: error || 'Douyin account session has expired',
    });
  }

  private async prepareBrowserLoginSession(
    session: DouyinBrowserLoginSession
  ): Promise<void> {
    try {
      session.target = await this.browserProfileService.createLoginTarget(
        session.roomId
      );
      if (!this.isSessionOperationActive(session)) {
        await this.closeBrowserLoginSession(session);
        return;
      }
      await this.browserProfileService.openLoginPanel(session.target.page);
      if (!this.isSessionOperationActive(session)) {
        await this.closeBrowserLoginSession(session);
        return;
      }
      session.status = 'waiting';
      session.updatedAt = new Date();
      session.pollTimer = setInterval(() => {
        void this.checkBrowserLoginSession(session);
      }, BROWSER_LOGIN_POLL_MS);
      await this.checkBrowserLoginSession(session);
    } catch (error) {
      if (!this.isSessionOperationActive(session)) {
        await this.closeBrowserLoginSession(session);
        return;
      }
      session.status = 'failed';
      session.error = this.errorMessage(error);
      session.updatedAt = new Date();
      if (session.operation) {
        await this.transitionForOperation(
          session.operation,
          'unknown',
          {
            lastValidationCode: 'BROWSER_UNAVAILABLE',
            lastValidationError: session.error,
          },
          true
        );
        this.releaseOperation(session.operation);
      }
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
    if (session.checkPromise) {
      return session.checkPromise;
    }
    session.checkPromise = this.withBrowserPageOperation(session, () =>
      this.doCheckBrowserLoginSession(session)
    ).finally(() => {
      session.checkPromise = undefined;
    });
    return session.checkPromise;
  }

  private async doCheckBrowserLoginSession(
    session: DouyinBrowserLoginSession
  ): Promise<void> {
    if (!this.isSessionOperationActive(session)) {
      return;
    }
    if (Date.now() >= session.expiresAt.getTime()) {
      await this.expireBrowserLoginSession(session.id, true);
      return;
    }

    const page = session.target?.page;
    if (!page || page.isClosed()) {
      return;
    }

    try {
      // A challenge must win over provisional session cookies.
      const verificationState =
        await this.browserProfileService.detectVerificationState(page);
      if (!this.isSessionOperationActive(session)) {
        return;
      }
      if (verificationState) {
        await this.enterVerificationRequired(
          session,
          verificationState.challenge,
          undefined,
          verificationState.awaitingCode
        );
        return;
      }

      const diagnostics = await this.browserProfileService.getCookieDiagnostics(
        session.target!.browserContext
      );
      if (!this.isSessionOperationActive(session)) {
        return;
      }
      if (diagnostics.authenticatedCookieNames.length === 0) {
        session.status = 'waiting';
        session.verification = undefined;
        session.updatedAt = new Date();
        return;
      }

      session.status = 'validating';
      session.updatedAt = new Date();
      const operation = session.operation;
      if (!operation) {
        return;
      }
      const validating = await this.transitionForOperation(
        operation,
        'validating',
        {
          cookieNames: diagnostics.cookieNames,
          authExpiresAt: diagnostics.authExpiresAt || null,
          lastValidationCode: null,
          lastValidationError: null,
        }
      );
      if (!validating || !this.isSessionOperationActive(session)) {
        return;
      }

      const probe = await this.browserProfileService.probe(
        page,
        session.roomId
      );
      if (!this.isSessionOperationActive(session)) {
        return;
      }
      if (probe.state === 'challenged') {
        await this.enterVerificationRequired(
          session,
          probe.challenge || 'captcha',
          probe
        );
        return;
      }
      if (probe.state === 'expired') {
        session.status = 'waiting';
        session.verification = undefined;
        session.updatedAt = new Date();
        await this.persistProbe(probe, operation);
        await this.browserProfileService.openLoginPanel(page);
        return;
      }
      if (probe.state === 'transient') {
        session.status = 'validating';
        session.error = probe.reason;
        session.updatedAt = new Date();
        await this.persistProbe(probe, operation);
        return;
      }

      if (!(await this.persistProbe(probe, operation, true))) {
        return;
      }
      session.status = 'authenticated';
      session.cookieNames = probe.cookieNames;
      session.verifiedAt = new Date();
      session.verification = undefined;
      session.error = undefined;
      session.updatedAt = new Date();
      this.releaseOperation(operation);
      await this.closeBrowserLoginSession(session);
    } catch (error) {
      if (this.isTransientNavigationError(error)) {
        session.updatedAt = new Date();
        return;
      }
      const message = this.errorMessage(error);
      if (!this.isSessionOperationActive(session)) {
        return;
      }
      session.status = 'validating';
      session.error = message;
      session.updatedAt = new Date();
      if (session.operation) {
        await this.transitionForOperation(session.operation, 'unknown', {
          lastValidationCode: 'TRANSIENT_ERROR',
          lastValidationError: message,
        });
      }
      this.logger?.warn('Douyin browser login validation was inconclusive', {
        sessionId: session.id,
        error: message,
      });
    }
  }

  private async enterVerificationRequired(
    session: DouyinBrowserLoginSession,
    challenge: DouyinProfileChallenge,
    probe?: DouyinProfileProbeResult,
    awaitingCode = false
  ): Promise<void> {
    if (!session.operation || !this.isSessionOperationActive(session)) {
      return;
    }
    const page = session.target?.page;
    const availableMethods =
      !awaitingCode &&
      challenge === 'second_verification' &&
      page &&
      !page.isClosed()
        ? await this.browserProfileService.getAvailableVerificationMethods(page)
        : [];
    const previousVerification = session.verification;
    session.status = 'verification_required';
    session.error = undefined;
    if (awaitingCode) {
      session.verification = {
        challenge: 'second_verification',
        stage: 'awaiting_code',
        method: 'receive_sms',
        availableMethods: [],
        prompt: '验证码已发送到绑定手机，请在这里输入。',
      };
    } else {
      session.verification =
        previousVerification?.challenge === challenge &&
        previousVerification.stage !== 'choose_method'
          ? {
              ...previousVerification,
              availableMethods,
            }
          : {
              challenge,
              stage: 'choose_method',
              availableMethods,
              prompt:
                challenge === 'second_verification'
                  ? availableMethods.length > 0
                    ? '抖音要求完成账号二次验证。'
                    : '正在读取抖音提供的验证方式，请稍候。'
                  : '抖音要求完成安全验证。',
            };
    }
    session.updatedAt = new Date();
    await this.transitionForOperation(session.operation, 'challenged', {
      cookieNames: probe?.cookieNames,
      authExpiresAt: probe?.authExpiresAt || null,
      lastValidationCode:
        challenge === 'second_verification'
          ? 'SECONDARY_VERIFICATION_REQUIRED'
          : 'CAPTCHA_REQUIRED',
      lastValidationError:
        probe?.reason ||
        (challenge === 'second_verification'
          ? 'Douyin secondary verification is required'
          : 'Douyin captcha verification is required'),
    });
  }

  private async persistProbe(
    probe: DouyinProfileProbeResult,
    operation: DouyinCredentialOperation,
    completeOperation = false
  ): Promise<boolean> {
    const now = new Date();
    if (probe.state === 'valid') {
      return Boolean(
        await this.transitionForOperation(
          operation,
          'valid',
          {
            cookieNames: probe.cookieNames,
            verifiedAt: now,
            authExpiresAt: probe.authExpiresAt || null,
            lastValidationCode: null,
            lastValidationError: null,
          },
          completeOperation
        )
      );
    }
    if (probe.state === 'challenged') {
      return Boolean(
        await this.transitionForOperation(
          operation,
          'challenged',
          {
            cookieNames: probe.cookieNames,
            authExpiresAt: probe.authExpiresAt || null,
            lastValidationCode:
              probe.challenge === 'second_verification'
                ? 'SECONDARY_VERIFICATION_REQUIRED'
                : 'CAPTCHA_REQUIRED',
            lastValidationError:
              probe.reason || 'Douyin verification is required',
          },
          completeOperation
        )
      );
    }
    if (probe.state === 'expired') {
      return Boolean(
        await this.transitionForOperation(
          operation,
          'expired',
          {
            cookieNames: probe.cookieNames,
            verifiedAt: null,
            authExpiresAt: probe.authExpiresAt || null,
            lastValidationCode: 'SESSION_EXPIRED',
            lastValidationError: probe.reason || 'Douyin session expired',
          },
          completeOperation
        )
      );
    }
    return Boolean(
      await this.transitionForOperation(
        operation,
        'unknown',
        {
          cookieNames: probe.cookieNames,
          authExpiresAt: probe.authExpiresAt || null,
          lastValidationCode: 'TRANSIENT_ERROR',
          lastValidationError:
            probe.reason || 'Douyin profile validation was inconclusive',
        },
        completeOperation
      )
    );
  }

  private toVerification(
    probe: DouyinProfileProbeResult
  ): DouyinCookieVerification {
    return {
      ok: probe.state === 'valid',
      cookieNames: probe.cookieNames,
      verifiedAt: probe.state === 'valid' ? new Date() : undefined,
      statusCode: probe.statusCode,
      captchaDetected: probe.state === 'challenged',
      error: probe.state === 'valid' ? undefined : probe.reason,
    };
  }

  private async beginOperation(
    details: Omit<DouyinCredentialTransition, 'state'>
  ): Promise<DouyinCredentialOperation> {
    const started = await this.credentialRepository.beginOperation(
      randomUUID(),
      {
        state: 'validating',
        ...details,
      }
    );
    this.activeOperations.add(this.operationKey(started.operation));
    return started.operation;
  }

  private async transitionForOperation(
    operation: DouyinCredentialOperation,
    state: DouyinAuthState,
    details: Omit<DouyinCredentialTransition, 'state'>,
    completeOperation = false
  ) {
    const credential = await this.credentialRepository.transition(
      {
        state,
        ...details,
      },
      operation,
      completeOperation
    );
    if (!credential || completeOperation) {
      this.releaseOperation(operation);
    }
    return credential;
  }

  private async invalidateOperation(
    state: DouyinAuthState,
    details: Omit<DouyinCredentialTransition, 'state'>
  ): Promise<void> {
    this.activeOperations.clear();
    await this.credentialRepository.invalidateOperation({
      state,
      ...details,
    });
  }

  private async reconcileProfileState(): Promise<void> {
    if (this.logoutInProgress) {
      return;
    }
    if (this.reconciliationPromise) {
      return this.reconciliationPromise;
    }
    this.reconciliationPromise = this.doReconcileProfileState().finally(() => {
      this.reconciliationPromise = undefined;
    });
    return this.reconciliationPromise;
  }

  private async doReconcileProfileState(): Promise<void> {
    const operation = await this.beginOperation({
      lastValidationCode: null,
      lastValidationError: null,
    });
    let target: DouyinBrowserLoginTarget | undefined;
    try {
      target = await this.browserProfileService.createLoginTarget();
      const probe = await this.browserProfileService.probe(target.page);
      await this.persistProbe(probe, operation, true);
    } catch (error) {
      await this.transitionForOperation(
        operation,
        'unknown',
        {
          lastValidationCode: 'BROWSER_UNAVAILABLE',
          lastValidationError: this.errorMessage(error),
        },
        true
      );
    } finally {
      this.releaseOperation(operation);
      if (target) {
        await this.browserProfileService.closeTarget(target);
      }
    }
  }

  private isSessionOperationActive(
    session: DouyinBrowserLoginSession
  ): boolean {
    return (
      this.isActiveSession(session.status) &&
      Boolean(session.operation && this.isOperationActive(session.operation))
    );
  }

  private isOperationActive(operation?: DouyinCredentialOperation): boolean {
    return Boolean(
      operation?.id &&
        operation.generation > 0 &&
        this.activeOperations.has(this.operationKey(operation))
    );
  }

  private releaseOperation(operation?: DouyinCredentialOperation): void {
    if (operation) {
      this.activeOperations.delete(this.operationKey(operation));
    }
  }

  private operationKey(operation: DouyinCredentialOperation): string {
    return `${operation.generation}:${operation.id}`;
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
        session.target?.page &&
        !session.target.page.isClosed() &&
        this.isActiveSession(session.status)
          ? new Date()
          : undefined,
      cookieNames: session.cookieNames,
      verifiedAt: session.verifiedAt,
      error: session.error,
      verification: session.verification,
    };
  }

  private async expireBrowserLoginSession(
    sessionId: string,
    calledFromCheck = false
  ): Promise<void> {
    const session = this.browserLoginSessions.get(sessionId);
    if (!session) {
      return;
    }
    if (this.isActiveSession(session.status)) {
      session.status = 'expired';
      session.updatedAt = new Date();
      await this.invalidateOperation('unknown', {
        lastValidationCode: 'TRANSIENT_ERROR',
        lastValidationError:
          'Douyin browser login timed out; profile recheck started',
      });
      this.releaseOperation(session.operation);
    }
    await this.closeBrowserLoginSession(session, !calledFromCheck);
    await this.reconcileProfileState();
  }

  private async closeBrowserLoginSession(
    session: DouyinBrowserLoginSession,
    waitForWork = false
  ): Promise<void> {
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = undefined;
    }
    if (session.expireTimer) {
      clearTimeout(session.expireTimer);
      session.expireTimer = undefined;
    }
    await this.closeBrowserLoginTarget(session);
    if (waitForWork && session.preparePromise) {
      await session.preparePromise.catch(() => undefined);
      await this.closeBrowserLoginTarget(session);
    }
    if (waitForWork && session.checkPromise) {
      await Promise.race([
        session.checkPromise.catch(() => undefined),
        this.sleep(2_500),
      ]);
    }
  }

  private async closeBrowserLoginTarget(
    session: DouyinBrowserLoginSession
  ): Promise<void> {
    if (!session.target) {
      return;
    }
    const target = session.target;
    session.target = undefined;
    await this.browserProfileService.closeTarget(target);
  }

  private pruneBrowserLoginSessions(): void {
    const cutoff = Date.now() - BROWSER_LOGIN_TTL_MS;
    for (const [id, session] of this.browserLoginSessions.entries()) {
      if (
        !this.isActiveSession(session.status) &&
        session.updatedAt.getTime() < cutoff
      ) {
        this.browserLoginSessions.delete(id);
      }
    }
  }

  private async withBrowserPageOperation<T>(
    session: DouyinBrowserLoginSession,
    operation: () => Promise<T>
  ): Promise<T> {
    const previousOperation = session.pageOperation;
    let release!: () => void;
    const currentOperation = new Promise<void>(resolve => {
      release = resolve;
    });
    session.pageOperation = currentOperation;

    if (previousOperation) {
      await previousOperation;
    }

    try {
      return await operation();
    } finally {
      release();
      if (session.pageOperation === currentOperation) {
        session.pageOperation = undefined;
      }
    }
  }

  private isActiveSession(status: DouyinBrowserLoginState): boolean {
    return [
      'initializing',
      'waiting',
      'verification_required',
      'validating',
    ].includes(status);
  }

  private isTransientNavigationError(error: unknown): boolean {
    return /execution context was destroyed|navigating frame was detached|frame was detached|cannot find context with specified id/i.test(
      this.errorMessage(error)
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export function isDouyinIdentityVerificationText(text: string): boolean {
  return (
    /身份验证|身份认证|安全验证/.test(text) &&
    /短信验证码|刷脸验证|刷脸认证|本人操作|验证方式/.test(text)
  );
}
