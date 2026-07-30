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
  DouyinCredentialOperationAcquireOptions,
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
const BROWSER_LOGIN_VERIFICATION_SETTLE_MS = 6_000;
const BROWSER_LOGIN_REQUIRED_CONFIRMATIONS = 2;
const BROWSER_LOGIN_CLOSE_WAIT_MS = 30_000;
const BROWSER_LOGIN_PREPARE_CLOSE_WAIT_MS = 2_500;
const AUTH_REVALIDATION_INTERVAL_MS = 12 * 60 * 60 * 1000;
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
  verificationSubmittedAt?: Date;
  verificationClearedAt?: Date;
  successfulProbeCount?: number;
  rejectedProbeCount?: number;
  confirmedAccountFingerprint?: string;
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
  private operationAcquisitionTail: Promise<void> = Promise.resolve();

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

    const persistedOperation = this.persistedOperation(credential);
    if (persistedOperation && !this.isOperationActive(persistedOperation)) {
      await this.reconcileProfileState(persistedOperation);
      credential = await this.credentialRepository.findLatest();
    } else if (
      credential.state === 'valid' &&
      this.activeOperations.size === 0 &&
      ((credential.authExpiresAt &&
        credential.authExpiresAt.getTime() <= Date.now()) ||
        !credential.verifiedAt ||
        Date.now() - credential.verifiedAt.getTime() >=
          AUTH_REVALIDATION_INTERVAL_MS)
    ) {
      // This is the earliest persistent expiry across several authentication-
      // related cookies, including auxiliary passport cookies. Treat it as a
      // revalidation hint. Independently refresh the server-side verdict at a
      // low frequency because Douyin may revoke a session before Cookie expiry.
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
    if (this.getActiveBrowserLoginSession() || this.activeOperations.size > 0) {
      throw new DouyinCredentialError(
        'Douyin browser login is in progress; wait for it to finish before checking the profile',
        409
      );
    }

    const operation = await this.beginOperation({
      lastValidationCode: null,
      lastValidationError: null,
    });

    let target: DouyinBrowserLoginTarget | undefined;
    try {
      target = await this.browserProfileService.createLoginTarget(roomId);
      const probe = await this.probePersistedProfile(target.page, roomId);
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
      const sessions = Array.from(this.browserLoginSessions.values());
      for (const session of sessions) {
        session.status = 'cancelled';
        session.updatedAt = new Date();
        this.releaseOperation(session.operation);
        await this.closeBrowserLoginSession(session, true);
      }
      this.browserLoginSessions.clear();

      operation = await this.beginOperation(
        {
          lastValidationCode: null,
          lastValidationError: null,
        },
        { replaceActive: true }
      );
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

  async startBrowserLogin(
    roomId?: string,
    options: { fresh?: boolean } = {}
  ): Promise<DouyinBrowserLoginStatus> {
    if (this.logoutInProgress) {
      throw new DouyinCredentialError('Douyin logout is in progress', 409);
    }
    this.pruneBrowserLoginSessions();
    await this.retireSupersededBrowserLoginSessions();
    const activeSession = this.getActiveBrowserLoginSession();
    if (activeSession) {
      await this.checkBrowserLoginSession(activeSession);
      if (options.fresh !== true) {
        return this.serializeBrowserLoginSession(activeSession);
      }
    }

    let shouldClearProfile = options.fresh !== false;
    if (!shouldClearProfile) {
      let credential = await this.credentialRepository.findLatest();
      const persistedOperation = this.persistedOperation(credential);
      if (persistedOperation && !this.isOperationActive(persistedOperation)) {
        await this.reconcileProfileState(persistedOperation);
        credential = await this.credentialRepository.findLatest();
      }
      // `fresh: false` is only a continuation hint. The server remains the
      // authority and permits it solely for a profile already known to be in
      // an interactive challenge.
      shouldClearProfile = credential?.state !== 'challenged';
    }

    if (shouldClearProfile) {
      // A fresh login must not silently accept whichever account is already in
      // the persistent profile, even when database metadata was lost.
      await this.clear();
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

    session.operation = await this.beginOperation({
      lastValidationCode: null,
      lastValidationError: null,
    });
    session.expireTimer = setTimeout(() => {
      void this.expireBrowserLoginSession(session.id).catch(error => {
        this.logger?.warn('Failed to expire Douyin browser login', {
          sessionId: session.id,
          error: this.errorMessage(error),
        });
      });
    }, BROWSER_LOGIN_TTL_MS);
    this.browserLoginSessions.set(session.id, session);
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
    if (
      this.isActiveSession(session.status) &&
      !this.isSessionOperationActive(session)
    ) {
      await this.retireSupersededBrowserLoginSession(session);
      return this.serializeBrowserLoginSession(session);
    }
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
        session.verificationSubmittedAt = undefined;
        session.verificationClearedAt = undefined;
        session.successfulProbeCount = 0;
        session.rejectedProbeCount = 0;
        session.confirmedAccountFingerprint = undefined;
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
          prompt: '验证码已提交，正在等待抖音完成登录确认。',
        };
        session.verificationSubmittedAt = new Date();
        session.verificationClearedAt = undefined;
        session.successfulProbeCount = 0;
        session.rejectedProbeCount = 0;
        session.confirmedAccountFingerprint = undefined;
      } else {
        throw new DouyinCredentialError(
          'Douyin verification interaction type is invalid'
        );
      }
      session.updatedAt = new Date();
    });

    session.updatedAt = new Date();
    return this.serializeBrowserLoginSession(session);
  }

  async cancelBrowserLogin(sessionId: string): Promise<void> {
    const session = this.getBrowserLoginSession(sessionId);
    session.status = 'cancelled';
    session.updatedAt = new Date();
    const cancelled = session.operation
      ? await this.transitionForOperation(
          session.operation,
          'unknown',
          {
            lastValidationCode: 'TRANSIENT_ERROR',
            lastValidationError: 'Douyin browser login was cancelled',
          },
          true
        )
      : null;
    await this.closeBrowserLoginSession(session, true);
    this.browserLoginSessions.delete(sessionId);
    if (cancelled) {
      await this.reconcileProfileState();
    }
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
    await this.transitionRuntimeState('challenged', {
      lastValidationCode: 'CAPTCHA_REQUIRED',
      lastValidationError:
        error || 'Douyin browser profile requires verification',
    });
  }

  async markRuntimeExpired(error?: string): Promise<void> {
    if (this.activeOperations.size > 0 || this.logoutInProgress) {
      return;
    }
    await this.transitionRuntimeState('expired', {
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
        session.verificationClearedAt = undefined;
        session.successfulProbeCount = 0;
        session.rejectedProbeCount = 0;
        session.confirmedAccountFingerprint = undefined;
        if (
          session.verification?.stage === 'processing' &&
          session.verificationSubmittedAt &&
          Date.now() - session.verificationSubmittedAt.getTime() <
            BROWSER_LOGIN_VERIFICATION_SETTLE_MS
        ) {
          session.status = 'verification_required';
          session.updatedAt = new Date();
          return;
        }
        await this.enterVerificationRequired(
          session,
          verificationState.challenge,
          undefined,
          verificationState.awaitingCode
        );
        return;
      }

      if (session.verification) {
        if (!session.verificationClearedAt) {
          session.verificationClearedAt = new Date();
          session.verification = {
            ...session.verification,
            stage: 'processing',
            prompt: '验证页面已完成，正在等待抖音确认账号登录态。',
          };
          session.status = 'verification_required';
          session.updatedAt = new Date();
          return;
        }
        if (
          Date.now() - session.verificationClearedAt.getTime() <
          BROWSER_LOGIN_VERIFICATION_SETTLE_MS
        ) {
          session.status = 'verification_required';
          session.updatedAt = new Date();
          return;
        }
      }

      if (await this.browserProfileService.isLoginRequired(page)) {
        session.status = 'waiting';
        session.verification = undefined;
        session.verificationSubmittedAt = undefined;
        session.verificationClearedAt = undefined;
        session.successfulProbeCount = 0;
        session.rejectedProbeCount = 0;
        session.confirmedAccountFingerprint = undefined;
        session.error = undefined;
        session.updatedAt = new Date();
        return;
      }

      const diagnostics = await this.browserProfileService.getCookieDiagnostics(
        session.target!.browserContext
      );
      if (!this.isSessionOperationActive(session)) {
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
        const interactiveVerification =
          await this.browserProfileService.detectVerificationState(page);
        if (interactiveVerification) {
          await this.enterVerificationRequired(
            session,
            interactiveVerification.challenge,
            probe,
            interactiveVerification.awaitingCode
          );
        } else {
          session.status = 'validating';
          session.error =
            probe.reason || 'Douyin verification is still being prepared';
          session.updatedAt = new Date();
        }
        return;
      }
      if (probe.state === 'expired') {
        session.successfulProbeCount = 0;
        session.confirmedAccountFingerprint = undefined;
        session.rejectedProbeCount = (session.rejectedProbeCount || 0) + 1;
        if (session.rejectedProbeCount < BROWSER_LOGIN_REQUIRED_CONFIRMATIONS) {
          session.status = 'validating';
          session.error = '正在再次确认抖音服务端的登录结果。';
          session.updatedAt = new Date();
          return;
        }
        session.status = 'waiting';
        session.verification = undefined;
        session.verificationSubmittedAt = undefined;
        session.verificationClearedAt = undefined;
        session.rejectedProbeCount = 0;
        session.error = undefined;
        session.updatedAt = new Date();
        await this.persistProbe(probe, operation);
        await this.browserProfileService.openLoginPanel(page);
        return;
      }
      if (probe.state === 'transient') {
        session.successfulProbeCount = 0;
        session.rejectedProbeCount = 0;
        session.confirmedAccountFingerprint = undefined;
        session.status = 'validating';
        session.error = probe.reason;
        session.updatedAt = new Date();
        await this.persistProbe(probe, operation);
        return;
      }

      session.rejectedProbeCount = 0;
      if (!probe.accountFingerprint) {
        session.successfulProbeCount = 0;
        session.confirmedAccountFingerprint = undefined;
        session.status = 'validating';
        session.error = '抖音服务端未返回可确认的账号身份，正在重试。';
        session.updatedAt = new Date();
        return;
      }
      if (session.confirmedAccountFingerprint !== probe.accountFingerprint) {
        session.confirmedAccountFingerprint = probe.accountFingerprint;
        session.successfulProbeCount = 1;
      } else {
        session.successfulProbeCount = (session.successfulProbeCount || 0) + 1;
      }
      if (session.successfulProbeCount < BROWSER_LOGIN_REQUIRED_CONFIRMATIONS) {
        session.status = 'validating';
        session.error = undefined;
        session.updatedAt = new Date();
        return;
      }
      if (!(await this.persistProbe(probe, operation, true))) {
        return;
      }
      session.status = 'authenticated';
      session.cookieNames = probe.cookieNames;
      session.verifiedAt = new Date();
      session.verification = undefined;
      session.verificationSubmittedAt = undefined;
      session.verificationClearedAt = undefined;
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
    session.successfulProbeCount = 0;
    session.rejectedProbeCount = 0;
    session.confirmedAccountFingerprint = undefined;
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
    details: Omit<DouyinCredentialTransition, 'state'>,
    acquireOptions: DouyinCredentialOperationAcquireOptions = {}
  ): Promise<DouyinCredentialOperation> {
    return this.withOperationAcquisitionLock(async () => {
      if (!acquireOptions.replaceActive && this.activeOperations.size > 0) {
        throw new DouyinCredentialError(
          'Another Douyin authentication operation is already in progress',
          409
        );
      }
      const started = await this.credentialRepository.beginOperation(
        randomUUID(),
        {
          state: 'validating',
          ...details,
        },
        acquireOptions
      );
      if (!started) {
        throw new DouyinCredentialError(
          'Another Douyin authentication operation is already in progress',
          409
        );
      }
      this.activeOperations.clear();
      this.activeOperations.add(this.operationKey(started.operation));
      return started.operation;
    });
  }

  private async withOperationAcquisitionLock<T>(
    task: () => Promise<T>
  ): Promise<T> {
    let releaseAcquisition!: () => void;
    const previousAcquisition = this.operationAcquisitionTail;
    this.operationAcquisitionTail = new Promise<void>(resolve => {
      releaseAcquisition = resolve;
    });
    await previousAcquisition;

    try {
      return await task();
    } finally {
      releaseAcquisition();
    }
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

  private async transitionRuntimeState(
    state: DouyinAuthState,
    details: Omit<DouyinCredentialTransition, 'state'>
  ): Promise<void> {
    await this.withOperationAcquisitionLock(async () => {
      // Recheck inside the same local critical section as operation acquire.
      // A runtime event that started earlier is committed before a new auth
      // operation; one queued later observes the new owner and becomes a no-op.
      if (this.logoutInProgress || this.activeOperations.size > 0) {
        return;
      }
      await this.credentialRepository.transitionWhenIdle({
        state,
        ...details,
      });
    });
  }

  private async reconcileProfileState(
    expectedOperation?: DouyinCredentialOperation
  ): Promise<void> {
    if (this.logoutInProgress || this.activeOperations.size > 0) {
      return;
    }
    if (this.reconciliationPromise) {
      return this.reconciliationPromise;
    }
    this.reconciliationPromise = this.doReconcileProfileState(
      expectedOperation
    ).finally(() => {
      this.reconciliationPromise = undefined;
    });
    return this.reconciliationPromise;
  }

  private async doReconcileProfileState(
    expectedOperation?: DouyinCredentialOperation
  ): Promise<void> {
    let operation: DouyinCredentialOperation;
    try {
      operation = await this.beginOperation(
        {
          lastValidationCode: null,
          lastValidationError: null,
        },
        expectedOperation ? { expectedOperation } : {}
      );
    } catch (error) {
      if (error instanceof DouyinCredentialError && error.status === 409) {
        return;
      }
      throw error;
    }
    let target: DouyinBrowserLoginTarget | undefined;
    try {
      target = await this.browserProfileService.createLoginTarget();
      const probe = await this.probePersistedProfile(target.page);
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

  private async probePersistedProfile(
    page: DouyinBrowserLoginTarget['page'],
    roomId?: string
  ): Promise<DouyinProfileProbeResult> {
    const first = await this.browserProfileService.probe(page, roomId);
    if (first.state !== 'valid' && first.state !== 'expired') {
      return first;
    }
    if (first.state === 'valid' && !first.accountFingerprint) {
      return {
        ...first,
        state: 'transient',
        reason: 'Douyin account endpoint did not confirm a stable identity',
      };
    }

    const second = await this.browserProfileService.probe(page, roomId);
    if (second.state === 'challenged') {
      return second;
    }
    if (
      first.state === 'valid' &&
      second.state === 'valid' &&
      first.accountFingerprint === second.accountFingerprint
    ) {
      return second;
    }
    if (first.state === 'expired' && second.state === 'expired') {
      return second;
    }
    return {
      ...second,
      state: 'transient',
      reason:
        'Douyin account state changed between consecutive server confirmations',
    };
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

  private persistedOperation(
    credential: Awaited<ReturnType<DouyinCredentialRepository['findLatest']>>
  ): DouyinCredentialOperation | undefined {
    return credential?.operationId && (credential.generation || 0) > 0
      ? {
          id: credential.operationId,
          generation: credential.generation || 0,
        }
      : undefined;
  }

  private getBrowserLoginSession(sessionId: string): DouyinBrowserLoginSession {
    const session = this.browserLoginSessions.get(sessionId);
    if (!session) {
      throw new DouyinCredentialError('Douyin login session not found', 404);
    }
    return session;
  }

  private getActiveBrowserLoginSession():
    | DouyinBrowserLoginSession
    | undefined {
    return Array.from(this.browserLoginSessions.values()).find(session =>
      this.isSessionOperationActive(session)
    );
  }

  private async retireSupersededBrowserLoginSessions(): Promise<void> {
    for (const session of this.browserLoginSessions.values()) {
      if (
        this.isActiveSession(session.status) &&
        !this.isSessionOperationActive(session)
      ) {
        await this.retireSupersededBrowserLoginSession(session);
      }
    }
  }

  private async retireSupersededBrowserLoginSession(
    session: DouyinBrowserLoginSession
  ): Promise<void> {
    session.status = 'failed';
    session.error = 'Douyin login session was superseded; start a new login';
    session.updatedAt = new Date();
    await this.closeBrowserLoginSession(session, true);
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
      const expired = session.operation
        ? await this.transitionForOperation(
            session.operation,
            'unknown',
            {
              lastValidationCode: 'TRANSIENT_ERROR',
              lastValidationError:
                'Douyin browser login timed out; profile recheck started',
            },
            true
          )
        : null;
      await this.closeBrowserLoginSession(session, !calledFromCheck);
      if (expired) {
        await this.reconcileProfileState();
      }
      return;
    }
    await this.closeBrowserLoginSession(session, !calledFromCheck);
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
    if (waitForWork && session.checkPromise) {
      await this.waitAtMost(session.checkPromise, BROWSER_LOGIN_CLOSE_WAIT_MS);
    }
    await this.closeBrowserLoginTarget(session);
    if (waitForWork && session.preparePromise) {
      await this.waitAtMost(
        session.preparePromise,
        BROWSER_LOGIN_PREPARE_CLOSE_WAIT_MS
      );
      await this.closeBrowserLoginTarget(session);
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

  private async waitAtMost(
    promise: Promise<unknown>,
    timeoutMs: number
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        promise.catch(() => undefined),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export function isDouyinIdentityVerificationText(text: string): boolean {
  return (
    /身份验证|身份认证|安全验证/.test(text) &&
    /短信验证码|刷脸验证|刷脸认证|本人操作|验证方式/.test(text)
  );
}
