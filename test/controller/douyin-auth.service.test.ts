import {
  DouyinAuthService,
  DouyinCredentialError,
  isDouyinIdentityVerificationText,
} from '../../src/service/douyin-auth.service';

describe('DouyinAuthService', () => {
  const createService = () => {
    const service = new DouyinAuthService() as any;
    let credential: any = null;
    let generation = 0;
    const applyTransition = (
      transition: any,
      operationId: string | null,
      nextGeneration: number
    ) => {
      const now = new Date('2026-07-28T00:00:00.000Z');
      credential = {
        ...(credential || {}),
        slot: 'default',
        cookieNames: transition.cookieNames ?? credential?.cookieNames ?? [],
        verifiedAt:
          transition.verifiedAt !== undefined
            ? transition.verifiedAt
            : credential?.verifiedAt ?? null,
        authExpiresAt:
          transition.authExpiresAt !== undefined
            ? transition.authExpiresAt
            : credential?.authExpiresAt ?? null,
        ...transition,
        operationId,
        generation: nextGeneration,
        stateChangedAt:
          credential?.state === transition.state
            ? credential.stateChangedAt
            : now,
        updatedAt: now,
      };
      return credential;
    };
    service.credentialRepository = {
      findLatest: jest.fn(async () => credential),
      beginOperation: jest.fn(
        async (operationId, transition, options: any = {}) => {
          if (!options.replaceActive) {
            if (
              options.expectedOperation &&
              (credential?.operationId !== options.expectedOperation.id ||
                credential?.generation !== options.expectedOperation.generation)
            ) {
              return null;
            }
            if (!options.expectedOperation && credential?.operationId) {
              return null;
            }
          }
          generation = Math.max(generation, credential?.generation || 0) + 1;
          return {
            credential: applyTransition(transition, operationId, generation),
            operation: { id: operationId, generation },
          };
        }
      ),
      transition: jest.fn(async (transition, operation, complete) => {
        if (
          operation &&
          (credential?.operationId !== operation.id ||
            credential?.generation !== operation.generation)
        ) {
          return null;
        }
        return applyTransition(
          transition,
          complete ? null : credential?.operationId ?? null,
          credential?.generation ?? generation
        );
      }),
      transitionWhenIdle: jest.fn(async transition => {
        if (credential?.operationId) {
          return null;
        }
        return applyTransition(
          transition,
          null,
          credential?.generation ?? generation
        );
      }),
    };
    service.browserProfileService = {
      createLoginTarget: jest.fn(),
      closeTarget: jest.fn().mockResolvedValue(undefined),
      probe: jest.fn(),
      logout: jest.fn().mockResolvedValue(undefined),
      openLoginPanel: jest.fn().mockResolvedValue(true),
      detectChallenge: jest.fn().mockResolvedValue(undefined),
      detectVerificationState: jest.fn().mockResolvedValue(undefined),
      isLoginRequired: jest.fn().mockResolvedValue(false),
      getCookieDiagnostics: jest.fn(),
      getAvailableVerificationMethods: jest
        .fn()
        .mockResolvedValue(['receive_sms', 'face', 'send_sms']),
      selectVerificationMethod: jest.fn().mockResolvedValue(true),
      submitVerificationCode: jest.fn().mockResolvedValue(true),
    };
    service.logger = {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };
    service.setCredential = (value: any) => {
      credential = value;
      generation = Math.max(generation, value?.generation || 0);
    };
    service.getCredential = () => credential;
    service.activateSession = (session: any) => {
      generation = Math.max(generation, credential?.generation || 0) + 1;
      const operation = { id: `operation-${generation}`, generation };
      applyTransition({ state: 'validating' }, operation.id, generation);
      session.operation = operation;
      service.activeOperations.add(`${generation}:${operation.id}`);
      return operation;
    };
    return service;
  };

  const createTarget = () =>
    ({
      page: {
        isClosed: jest.fn().mockReturnValue(false),
        screenshot: jest.fn().mockResolvedValue(Buffer.from('png')),
      },
      browserContext: {},
      browser: {},
      ownsBrowser: false,
    } as any);

  const createSession = (target = createTarget()) =>
    ({
      id: 'session-id',
      status: 'waiting',
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
      updatedAt: new Date('2026-07-28T00:00:00.000Z'),
      expiresAt: new Date(Date.now() + 60_000),
      roomId: '123456',
      target,
    } as any);

  it('reports an unconfigured profile without inventing authentication', async () => {
    const service = createService();

    await expect(service.getStatus()).resolves.toEqual({
      state: 'unconfigured',
      isAuthenticated: false,
      browserHealthy: true,
      profilePersistent: true,
    });
  });

  it('derives isAuthenticated strictly from the valid state', async () => {
    const service = createService();
    service.setCredential({
      state: 'challenged',
      cookieNames: ['sessionid'],
      verifiedAt: new Date('2026-07-27T00:00:00.000Z'),
      stateChangedAt: new Date('2026-07-28T00:00:00.000Z'),
      updatedAt: new Date('2026-07-28T00:00:00.000Z'),
      lastValidationCode: 'CAPTCHA_REQUIRED',
      lastValidationError: 'captcha',
    });

    const challenged = await service.getStatus();
    expect(challenged).toEqual(
      expect.objectContaining({
        state: 'challenged',
        isAuthenticated: false,
        source: 'browser_profile',
        lastValidationCode: 'CAPTCHA_REQUIRED',
      })
    );

    service.setCredential({
      ...service.getCredential(),
      state: 'valid',
      verifiedAt: new Date(),
      lastValidationCode: null,
      lastValidationError: null,
    });
    await expect(service.getStatus()).resolves.toEqual(
      expect.objectContaining({
        state: 'valid',
        isAuthenticated: true,
      })
    );
  });

  it('retires raw Cookie import and never persists a flattened header', async () => {
    const service = createService();

    await expect(
      service.saveCookie('sessionid=secret', { verify: false })
    ).rejects.toMatchObject({
      status: 410,
    });
    await expect(
      service.verifyCookie('sessionid=secret')
    ).rejects.toBeInstanceOf(DouyinCredentialError);
    expect(service.credentialRepository.transition).not.toHaveBeenCalled();
    expect(JSON.stringify(service.getCredential())).not.toContain('secret');
  });

  it('marks a browser profile valid only after a real probe succeeds', async () => {
    const service = createService();
    const target = createTarget();
    service.browserProfileService.createLoginTarget.mockResolvedValue(target);
    service.browserProfileService.probe.mockResolvedValue({
      state: 'valid',
      finalUrl: 'https://live.douyin.com/123456',
      statusCode: 200,
      cookieNames: ['sessionid', 'ttwid'],
      authenticatedCookieNames: ['sessionid'],
      authExpiresAt: new Date('2026-09-25T00:00:00.000Z'),
      accountFingerprint: 'a'.repeat(64),
    });

    const result = await service.verifyCookie(undefined, '123456');

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        cookieNames: ['sessionid', 'ttwid'],
      })
    );
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'valid',
        cookieNames: ['sessionid', 'ttwid'],
        lastValidationError: null,
      })
    );
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      target
    );
    expect(service.browserProfileService.probe).toHaveBeenCalledTimes(2);
  });

  it('does not persist a profile when consecutive account identities differ', async () => {
    const service = createService();
    const target = createTarget();
    service.browserProfileService.createLoginTarget.mockResolvedValue(target);
    service.browserProfileService.probe
      .mockResolvedValueOnce({
        state: 'valid',
        finalUrl: 'https://www.douyin.com/',
        cookieNames: ['sessionid'],
        authenticatedCookieNames: ['sessionid'],
        accountFingerprint: 'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        state: 'valid',
        finalUrl: 'https://www.douyin.com/',
        cookieNames: ['sessionid'],
        authenticatedCookieNames: ['sessionid'],
        accountFingerprint: 'b'.repeat(64),
      });

    const result = await service.verifyCookie();

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining('changed between consecutive'),
      })
    );
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'unknown',
        lastValidationCode: 'TRANSIENT_ERROR',
      })
    );
  });

  it('keeps captcha, expiry, and transient failures as distinct states', async () => {
    const cases = [
      {
        probe: {
          state: 'challenged',
          challenge: 'captcha',
          reason: 'captcha',
        },
        expected: 'challenged',
      },
      {
        probe: {
          state: 'expired',
          reason: 'login required',
        },
        expected: 'expired',
      },
      {
        probe: {
          state: 'transient',
          reason: 'network timeout',
        },
        expected: 'unknown',
      },
    ] as const;

    for (const testCase of cases) {
      const service = createService();
      const target = createTarget();
      service.browserProfileService.createLoginTarget.mockResolvedValue(target);
      service.browserProfileService.probe.mockResolvedValue({
        finalUrl: 'https://www.douyin.com/',
        cookieNames: [],
        authenticatedCookieNames: [],
        ...testCase.probe,
      });

      const result = await service.verifyCookie();

      expect(result.ok).toBe(false);
      expect(service.getCredential().state).toBe(testCase.expected);
    }
  });

  it('checks verification UI before provisional authenticated cookies', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    service.browserProfileService.detectVerificationState.mockResolvedValue({
      challenge: 'second_verification',
      awaitingCode: false,
    });

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('verification_required');
    expect(session.verification).toEqual(
      expect.objectContaining({
        challenge: 'second_verification',
        stage: 'choose_method',
        availableMethods: ['receive_sms', 'face', 'send_sms'],
      })
    );
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'challenged',
        lastValidationCode: 'SECONDARY_VERIFICATION_REQUIRED',
      })
    );
    expect(service.browserProfileService.probe).not.toHaveBeenCalled();
  });

  it('does not advertise secondary methods for a captcha challenge', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    service.browserProfileService.detectVerificationState.mockResolvedValue({
      challenge: 'captcha',
      awaitingCode: false,
    });

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('verification_required');
    expect(session.verification).toEqual(
      expect.objectContaining({
        challenge: 'captcha',
        stage: 'choose_method',
        availableMethods: [],
      })
    );
    expect(
      service.browserProfileService.getAvailableVerificationMethods
    ).not.toHaveBeenCalled();

    service.browserLoginSessions.set(session.id, session);
    await expect(
      service.interactWithBrowserLogin(session.id, {
        type: 'select_verification_method',
        method: 'receive_sms',
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(session.verification.challenge).toBe('captcha');
    expect(
      service.browserProfileService.selectVerificationMethod
    ).not.toHaveBeenCalled();
  });

  it('keeps the session on the concrete SMS code step during polling', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    session.status = 'verification_required';
    session.verification = {
      challenge: 'second_verification',
      stage: 'processing',
      method: 'receive_sms',
      availableMethods: ['receive_sms'],
    };
    service.browserProfileService.detectVerificationState.mockResolvedValue({
      challenge: 'second_verification',
      awaitingCode: true,
    });

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('verification_required');
    expect(session.verification).toEqual({
      challenge: 'second_verification',
      stage: 'awaiting_code',
      method: 'receive_sms',
      availableMethods: [],
      prompt: '验证码已发送到绑定手机，请在这里输入。',
    });
    expect(
      service.browserProfileService.getCookieDiagnostics
    ).not.toHaveBeenCalled();
  });

  it('does not authenticate from Cookie names without a successful probe', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    service.browserProfileService.getCookieDiagnostics.mockResolvedValue({
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
    });
    service.browserProfileService.probe.mockResolvedValue({
      state: 'transient',
      finalUrl: 'https://live.douyin.com/123456',
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
      reason: 'room data unavailable',
    });

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('validating');
    expect(service.getCredential().state).toBe('unknown');
    expect(service.browserProfileService.closeTarget).not.toHaveBeenCalled();
  });

  it('uses Cookie names only as diagnostics and still validates unknown names', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    service.browserProfileService.getCookieDiagnostics.mockResolvedValue({
      cookieNames: ['future_auth_cookie'],
      authenticatedCookieNames: [],
    });
    service.browserProfileService.probe.mockResolvedValue({
      state: 'valid',
      finalUrl: 'https://www.douyin.com/',
      statusCode: 200,
      cookieNames: ['future_auth_cookie'],
      authenticatedCookieNames: [],
      accountFingerprint: 'a'.repeat(64),
    });

    await service.checkBrowserLoginSession(session);
    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('authenticated');
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'valid',
        cookieNames: ['future_auth_cookie'],
      })
    );
    expect(service.browserProfileService.probe).toHaveBeenCalledTimes(2);
  });

  it('rejects provisional login Cookies when the account endpoint does not confirm an identity', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    service.browserProfileService.getCookieDiagnostics.mockResolvedValue({
      cookieNames: ['sessionid', 'sid_guard'],
      authenticatedCookieNames: ['sessionid', 'sid_guard'],
    });
    service.browserProfileService.probe.mockResolvedValue({
      state: 'expired',
      finalUrl: 'https://www.douyin.com/',
      statusCode: 200,
      cookieNames: ['sessionid', 'sid_guard'],
      authenticatedCookieNames: ['sessionid', 'sid_guard'],
      reason: 'Douyin account session is not authenticated',
    });

    await service.checkBrowserLoginSession(session);
    expect(session.status).toBe('validating');
    expect(service.getCredential().state).toBe('validating');
    expect(service.browserProfileService.openLoginPanel).not.toHaveBeenCalled();

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('waiting');
    expect(session.verifiedAt).toBeUndefined();
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'expired',
        verifiedAt: null,
        lastValidationCode: 'SESSION_EXPIRED',
      })
    );
    expect(service.browserProfileService.closeTarget).not.toHaveBeenCalled();
    expect(service.browserProfileService.openLoginPanel).toHaveBeenCalledWith(
      session.target.page
    );
    expect(service.browserProfileService.probe).toHaveBeenCalledTimes(2);
  });

  it('completes login only after the persisted profile probe succeeds', async () => {
    const service = createService();
    const target = createTarget();
    const session = createSession(target);
    service.activateSession(session);
    service.browserProfileService.getCookieDiagnostics.mockResolvedValue({
      cookieNames: ['sessionid', 'ttwid'],
      authenticatedCookieNames: ['sessionid'],
    });
    service.browserProfileService.probe.mockResolvedValue({
      state: 'valid',
      finalUrl: 'https://live.douyin.com/123456',
      statusCode: 200,
      cookieNames: ['sessionid', 'ttwid'],
      authenticatedCookieNames: ['sessionid'],
      accountFingerprint: 'a'.repeat(64),
    });

    await service.checkBrowserLoginSession(session);
    expect(session.status).toBe('validating');
    expect(service.getCredential().state).toBe('validating');
    expect(service.browserProfileService.closeTarget).not.toHaveBeenCalled();

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('authenticated');
    expect(service.getCredential().state).toBe('valid');
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      target
    );
    expect(service.browserProfileService.probe).toHaveBeenCalledTimes(2);
  });

  it('requires consecutive confirmations for the same Douyin account', async () => {
    const service = createService();
    const target = createTarget();
    const session = createSession(target);
    service.activateSession(session);
    service.browserProfileService.getCookieDiagnostics.mockResolvedValue({
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
    });
    service.browserProfileService.probe
      .mockResolvedValueOnce({
        state: 'valid',
        finalUrl: 'https://www.douyin.com/',
        statusCode: 200,
        cookieNames: ['sessionid'],
        authenticatedCookieNames: ['sessionid'],
        accountFingerprint: 'a'.repeat(64),
      })
      .mockResolvedValue({
        state: 'valid',
        finalUrl: 'https://www.douyin.com/',
        statusCode: 200,
        cookieNames: ['sessionid'],
        authenticatedCookieNames: ['sessionid'],
        accountFingerprint: 'b'.repeat(64),
      });

    await service.checkBrowserLoginSession(session);
    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('validating');
    expect(service.getCredential().state).toBe('validating');
    expect(service.browserProfileService.closeTarget).not.toHaveBeenCalled();

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('authenticated');
    expect(service.getCredential().state).toBe('valid');
    expect(service.browserProfileService.probe).toHaveBeenCalledTimes(3);
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      target
    );
  });

  it('serializes concurrent login checks through one in-flight probe', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    service.browserProfileService.detectVerificationState.mockImplementation(
      async () => {
        await gate;
        return undefined;
      }
    );
    service.browserProfileService.getCookieDiagnostics.mockResolvedValue({
      cookieNames: [],
      authenticatedCookieNames: [],
    });

    const first = service.checkBrowserLoginSession(session);
    const second = service.checkBrowserLoginSession(session);
    release();
    await Promise.all([first, second]);

    expect(
      service.browserProfileService.detectVerificationState
    ).toHaveBeenCalledTimes(1);
  });

  it('serializes verification interaction behind an in-flight login check', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    session.status = 'verification_required';
    session.verification = {
      challenge: 'second_verification',
      stage: 'choose_method',
      availableMethods: ['receive_sms'],
    };
    service.browserLoginSessions.set(session.id, session);

    let checkStarted!: () => void;
    const started = new Promise<void>(resolve => {
      checkStarted = resolve;
    });
    let releaseCheck!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseCheck = resolve;
    });
    const order: string[] = [];
    service.browserProfileService.detectVerificationState.mockImplementation(
      async () => {
        order.push('check-start');
        checkStarted();
        await gate;
        order.push('check-end');
        return {
          challenge: 'second_verification',
          awaitingCode: false,
        };
      }
    );
    service.browserProfileService.getAvailableVerificationMethods.mockResolvedValue(
      ['receive_sms']
    );
    service.browserProfileService.selectVerificationMethod.mockImplementation(
      async () => {
        order.push('select');
        return true;
      }
    );

    const check = service.checkBrowserLoginSession(session);
    await started;
    const interaction = service.interactWithBrowserLogin(session.id, {
      type: 'select_verification_method',
      method: 'receive_sms',
    });
    await Promise.resolve();
    expect(order).toEqual(['check-start']);

    releaseCheck();
    await Promise.all([check, interaction]);

    expect(order).toEqual(['check-start', 'check-end', 'select']);
  });

  it('waits for an in-flight probe before disconnecting its browser target', async () => {
    const service = createService();
    const target = createTarget();
    const session = createSession(target);
    let releaseCheck!: () => void;
    session.checkPromise = new Promise<void>(resolve => {
      releaseCheck = resolve;
    });

    const closing = service.closeBrowserLoginSession(session, true);
    await Promise.resolve();

    expect(service.browserProfileService.closeTarget).not.toHaveBeenCalled();

    releaseCheck();
    await closing;

    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      target
    );
  });

  it('returns the active browser login session so the UI can reattach', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    service.browserLoginSessions.set(session.id, session);
    service.checkBrowserLoginSession = jest.fn().mockResolvedValue(undefined);

    const result = await service.startBrowserLogin('another-room');

    expect(result.sessionId).toBe(session.id);
    expect(result.status).toBe('waiting');
    expect(
      service.browserProfileService.createLoginTarget
    ).not.toHaveBeenCalled();
  });

  it('replaces an active challenged session for an explicit fresh login', async () => {
    const service = createService();
    const session = createSession();
    const target = session.target;
    service.activateSession(session);
    session.status = 'verification_required';
    service.browserLoginSessions.set(session.id, session);
    service.checkBrowserLoginSession = jest.fn().mockResolvedValue(undefined);
    service.prepareBrowserLoginSession = jest.fn().mockResolvedValue(undefined);

    const result = await service.startBrowserLogin(undefined, { fresh: true });

    expect(result.sessionId).not.toBe(session.id);
    expect(result.status).toBe('initializing');
    expect(service.browserLoginSessions.has(session.id)).toBe(false);
    expect(service.browserProfileService.logout).toHaveBeenCalledTimes(1);
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      target
    );
    clearTimeout(
      service.browserLoginSessions.get(result.sessionId)?.expireTimer
    );
  });

  it('returns a login session that becomes authenticated during reattachment', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    service.browserLoginSessions.set(session.id, session);
    service.checkBrowserLoginSession = jest.fn(async current => {
      current.status = 'authenticated';
      current.verifiedAt = new Date();
      service.releaseOperation(current.operation);
      service.setCredential({
        ...service.getCredential(),
        state: 'valid',
        operationId: null,
        verifiedAt: current.verifiedAt,
      });
    });

    const result = await service.startBrowserLogin();

    expect(result).toEqual(
      expect.objectContaining({
        sessionId: session.id,
        status: 'authenticated',
      })
    );
    expect(service.browserProfileService.logout).not.toHaveBeenCalled();
    expect(service.credentialRepository.beginOperation).not.toHaveBeenCalled();
  });

  it('serializes concurrent login starts without retiring the acquiring session', async () => {
    const service = createService();
    service.setCredential({
      slot: 'default',
      state: 'challenged',
      cookieNames: ['sessionid'],
      operationId: null,
      generation: 3,
      stateChangedAt: new Date(),
      updatedAt: new Date(),
    });
    service.prepareBrowserLoginSession = jest.fn().mockResolvedValue(undefined);
    const originalBegin = service.credentialRepository.beginOperation;
    let acquisitionStarted!: () => void;
    const started = new Promise<void>(resolve => {
      acquisitionStarted = resolve;
    });
    let releaseAcquisition!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseAcquisition = resolve;
    });
    service.credentialRepository.beginOperation = jest.fn(
      async (operationId, transition, options) => {
        acquisitionStarted();
        await gate;
        return originalBegin(operationId, transition, options);
      }
    );

    const first = service.startBrowserLogin(undefined, { fresh: false });
    await started;
    const second = service.startBrowserLogin(undefined, { fresh: false });
    releaseAcquisition();

    const firstResult = await first;
    await expect(second).rejects.toMatchObject({ status: 409 });

    expect(firstResult.status).toBe('initializing');
    expect(service.browserLoginSessions.get(firstResult.sessionId)).toEqual(
      expect.objectContaining({
        status: 'initializing',
        operation: expect.objectContaining({
          id: expect.any(String),
        }),
      })
    );
    expect(service.credentialRepository.beginOperation).toHaveBeenCalledTimes(
      1
    );
    clearTimeout(
      service.browserLoginSessions.get(firstResult.sessionId)?.expireTimer
    );
  });

  it('clears an existing account before starting a real account-switch login', async () => {
    const service = createService();
    service.setCredential({
      slot: 'default',
      state: 'valid',
      cookieNames: ['sessionid'],
      operationId: null,
      generation: 3,
      verifiedAt: new Date(),
      stateChangedAt: new Date(),
      updatedAt: new Date(),
    });
    service.prepareBrowserLoginSession = jest.fn().mockResolvedValue(undefined);

    const result = await service.startBrowserLogin();

    expect(result.status).toBe('initializing');
    expect(service.browserProfileService.logout).toHaveBeenCalledTimes(1);
    expect(service.credentialRepository.beginOperation).toHaveBeenCalledTimes(
      2
    );
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'validating',
        operationId: expect.any(String),
        generation: 5,
      })
    );
    clearTimeout(
      service.browserLoginSessions.get(result.sessionId)?.expireTimer
    );
  });

  it('continues an explicit challenged profile without clearing it', async () => {
    const service = createService();
    service.setCredential({
      slot: 'default',
      state: 'challenged',
      cookieNames: ['sessionid'],
      operationId: null,
      generation: 3,
      stateChangedAt: new Date(),
      updatedAt: new Date(),
    });
    service.prepareBrowserLoginSession = jest.fn().mockResolvedValue(undefined);

    const result = await service.startBrowserLogin(undefined, { fresh: false });

    expect(result.status).toBe('initializing');
    expect(service.browserProfileService.logout).not.toHaveBeenCalled();
    expect(service.credentialRepository.beginOperation).toHaveBeenCalledTimes(
      1
    );
    clearTimeout(
      service.browserLoginSessions.get(result.sessionId)?.expireTimer
    );
  });

  it('does not let fresh false reuse a profile that is not challenged', async () => {
    const service = createService();
    service.setCredential({
      slot: 'default',
      state: 'valid',
      cookieNames: ['sessionid'],
      operationId: null,
      generation: 3,
      verifiedAt: new Date(),
      stateChangedAt: new Date(),
      updatedAt: new Date(),
    });
    service.prepareBrowserLoginSession = jest.fn().mockResolvedValue(undefined);

    const result = await service.startBrowserLogin(undefined, { fresh: false });

    expect(result.status).toBe('initializing');
    expect(service.browserProfileService.logout).toHaveBeenCalledTimes(1);
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'validating',
        generation: 5,
      })
    );
    clearTimeout(
      service.browserLoginSessions.get(result.sessionId)?.expireTimer
    );
  });

  it('retires an in-memory login session after it loses operation ownership', async () => {
    const service = createService();
    const target = createTarget();
    const session = createSession(target);
    service.activateSession(session);
    service.browserLoginSessions.set(session.id, session);
    service.releaseOperation(session.operation);

    const result = await service.getBrowserLoginStatus(session.id);

    expect(result).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('superseded'),
      })
    );
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      target
    );
  });

  it('does not let a stale session timeout invalidate a newer operation', async () => {
    const service = createService();
    const session = createSession();
    const staleOperation = service.activateSession(session);
    service.browserLoginSessions.set(session.id, session);
    const newerOperation = {
      id: 'newer-operation',
      generation: staleOperation.generation + 1,
    };
    service.setCredential({
      ...service.getCredential(),
      state: 'validating',
      operationId: newerOperation.id,
      generation: newerOperation.generation,
    });
    service.activeOperations.clear();
    service.activeOperations.add(
      `${newerOperation.generation}:${newerOperation.id}`
    );

    await service.expireBrowserLoginSession(session.id);

    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        operationId: newerOperation.id,
        generation: newerOperation.generation,
      })
    );
    expect(service.activeOperations).toContain(
      `${newerOperation.generation}:${newerOperation.id}`
    );
    expect(
      service.browserProfileService.createLoginTarget
    ).not.toHaveBeenCalled();
  });

  it('does not let status or verification replace an active browser-login operation', async () => {
    const service = createService();
    const session = createSession();
    const operation = service.activateSession(session);
    service.browserLoginSessions.set(session.id, session);

    const status = await service.getStatus();
    await service.verifyCookie().catch(() => undefined);

    expect(status).toEqual(
      expect.objectContaining({
        state: 'validating',
        isAuthenticated: false,
      })
    );
    expect(service.credentialRepository.beginOperation).not.toHaveBeenCalled();
    expect(
      service.browserProfileService.createLoginTarget
    ).not.toHaveBeenCalled();
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        operationId: operation.id,
        generation: operation.generation,
      })
    );
    expect(service.activeOperations).toContain(
      `${operation.generation}:${operation.id}`
    );
  });

  it('rejects a stale in-flight probe after cancellation and restores the persisted profile state', async () => {
    const service = createService();
    const sessionTarget = createTarget();
    const reconciliationTarget = createTarget();
    const session = createSession(sessionTarget);
    service.activateSession(session);
    service.browserLoginSessions.set(session.id, session);
    service.browserProfileService.getCookieDiagnostics.mockResolvedValue({
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
    });

    let probeStarted!: () => void;
    const started = new Promise<void>(resolve => {
      probeStarted = resolve;
    });
    let releaseProbe!: (value: any) => void;
    const pendingProbe = new Promise<any>(resolve => {
      releaseProbe = resolve;
    });
    service.browserProfileService.probe
      .mockImplementationOnce(async () => {
        probeStarted();
        return pendingProbe;
      })
      .mockResolvedValue({
        state: 'expired',
        finalUrl: 'https://www.douyin.com/',
        cookieNames: [],
        authenticatedCookieNames: [],
        reason: 'login required',
      });
    service.browserProfileService.createLoginTarget.mockResolvedValue(
      reconciliationTarget
    );

    const check = service.checkBrowserLoginSession(session);
    await started;
    const cancellation = service.cancelBrowserLogin(session.id);
    releaseProbe({
      state: 'valid',
      finalUrl: 'https://www.douyin.com/',
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
    });
    await Promise.all([check, cancellation]);

    expect(service.browserLoginSessions.has(session.id)).toBe(false);
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'expired',
        operationId: null,
        lastValidationCode: 'SESSION_EXPIRED',
      })
    );
    expect(service.getCredential().state).not.toBe('validating');
  });

  it('cleans a target created during cancellation before reconciling the profile', async () => {
    const service = createService();
    const lateTarget = createTarget();
    const reconciliationTarget = createTarget();
    let releaseTarget!: (target: any) => void;
    const targetPending = new Promise<any>(resolve => {
      releaseTarget = resolve;
    });
    service.browserProfileService.createLoginTarget
      .mockImplementationOnce(() => targetPending)
      .mockResolvedValueOnce(reconciliationTarget);
    service.browserProfileService.probe.mockResolvedValue({
      state: 'expired',
      finalUrl: 'https://www.douyin.com/',
      cookieNames: [],
      authenticatedCookieNames: [],
      reason: 'login required',
    });

    const started = await service.startBrowserLogin();
    const cancellation = service.cancelBrowserLogin(started.sessionId);
    releaseTarget(lateTarget);
    await cancellation;

    expect(
      service.browserProfileService.openLoginPanel
    ).not.toHaveBeenCalledWith(lateTarget.page);
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      lateTarget
    );
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      reconciliationTarget
    );
    expect(service.getCredential().state).toBe('expired');
  });

  it('reconciles a validating operation left behind by a process restart', async () => {
    const service = createService();
    const target = createTarget();
    service.setCredential({
      slot: 'default',
      state: 'validating',
      cookieNames: ['sessionid'],
      operationId: 'operation-from-old-process',
      generation: 7,
      stateChangedAt: new Date('2026-07-28T00:00:00.000Z'),
      updatedAt: new Date('2026-07-28T00:00:00.000Z'),
    });
    service.browserProfileService.createLoginTarget.mockResolvedValue(target);
    service.browserProfileService.probe.mockResolvedValue({
      state: 'valid',
      finalUrl: 'https://www.douyin.com/',
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
      authExpiresAt: new Date('2026-09-25T00:00:00.000Z'),
      accountFingerprint: 'a'.repeat(64),
    });

    const status = await service.getStatus();

    expect(status).toEqual(
      expect.objectContaining({
        state: 'valid',
        isAuthenticated: true,
      })
    );
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        operationId: null,
        generation: 8,
      })
    );
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      target
    );
    expect(service.browserProfileService.probe).toHaveBeenCalledTimes(2);
  });

  it('uses Cookie expiry only as a revalidation hint when the account endpoint remains valid', async () => {
    const service = createService();
    const target = createTarget();
    service.setCredential({
      slot: 'default',
      state: 'valid',
      cookieNames: ['passport_auth_status', 'sessionid'],
      operationId: null,
      generation: 4,
      verifiedAt: new Date('2026-07-20T00:00:00.000Z'),
      authExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      stateChangedAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    });
    service.browserProfileService.createLoginTarget.mockResolvedValue(target);
    service.browserProfileService.probe.mockResolvedValue({
      state: 'valid',
      finalUrl: 'https://www.douyin.com/',
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
      authExpiresAt: new Date('2026-09-25T00:00:00.000Z'),
      accountFingerprint: 'a'.repeat(64),
    });

    const status = await service.getStatus();

    expect(status).toEqual(
      expect.objectContaining({
        state: 'valid',
        isAuthenticated: true,
        authExpiresAt: new Date('2026-09-25T00:00:00.000Z'),
      })
    );
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        operationId: null,
        generation: 5,
      })
    );
    expect(service.browserProfileService.probe).toHaveBeenCalledWith(
      target.page,
      undefined
    );
    expect(service.browserProfileService.probe).toHaveBeenCalledTimes(2);
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      target
    );
  });

  it('expires an elapsed Cookie hint only after the account endpoint confirms logout', async () => {
    const service = createService();
    const target = createTarget();
    service.setCredential({
      slot: 'default',
      state: 'valid',
      cookieNames: ['sessionid'],
      operationId: null,
      generation: 4,
      verifiedAt: new Date('2026-07-20T00:00:00.000Z'),
      authExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      stateChangedAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    });
    service.browserProfileService.createLoginTarget.mockResolvedValue(target);
    service.browserProfileService.probe.mockResolvedValue({
      state: 'expired',
      finalUrl: 'https://www.douyin.com/',
      cookieNames: [],
      authenticatedCookieNames: [],
      reason: 'login required',
    });

    const status = await service.getStatus();

    expect(status).toEqual(
      expect.objectContaining({
        state: 'expired',
        isAuthenticated: false,
        lastValidationCode: 'SESSION_EXPIRED',
      })
    );
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        verifiedAt: null,
        operationId: null,
        generation: 5,
      })
    );
  });

  it('proxies SMS verification without exposing the browser UI', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    session.status = 'verification_required';
    session.verification = {
      challenge: 'second_verification',
      stage: 'choose_method',
      availableMethods: ['receive_sms', 'face', 'send_sms'],
    };
    service.browserLoginSessions.set(session.id, session);

    const selected = await service.interactWithBrowserLogin(session.id, {
      type: 'select_verification_method',
      method: 'receive_sms',
    });
    expect(selected.verification).toEqual(
      expect.objectContaining({
        method: 'receive_sms',
        stage: 'awaiting_code',
      })
    );

    service.checkBrowserLoginSession = jest.fn().mockResolvedValue(undefined);
    await service.interactWithBrowserLogin(session.id, {
      type: 'submit_verification_code',
      code: '123456',
    });
    expect(
      service.browserProfileService.submitVerificationCode
    ).toHaveBeenCalledWith(session.target.page, '123456');
  });

  it('lets an SMS callback settle without an immediate fixed-delay login probe', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    session.status = 'verification_required';
    session.verification = {
      challenge: 'second_verification',
      stage: 'awaiting_code',
      method: 'receive_sms',
      availableMethods: ['receive_sms'],
    };
    service.browserLoginSessions.set(session.id, session);
    service.checkBrowserLoginSession = jest.fn().mockResolvedValue(undefined);

    const result = await service.interactWithBrowserLogin(session.id, {
      type: 'submit_verification_code',
      code: '123456',
    });

    expect(result.verification).toEqual(
      expect.objectContaining({
        method: 'receive_sms',
        stage: 'processing',
      })
    );
    expect(service.checkBrowserLoginSession).not.toHaveBeenCalled();
    expect(service.browserProfileService.probe).not.toHaveBeenCalled();
  });

  it('waits for a cleared verification page to settle before probing the profile', async () => {
    const service = createService();
    const session = createSession();
    service.activateSession(session);
    session.status = 'verification_required';
    session.verification = {
      challenge: 'second_verification',
      stage: 'processing',
      method: 'receive_sms',
      availableMethods: ['receive_sms'],
    };
    session.verificationClearedAt = new Date(Date.now() - 5_000);

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('verification_required');
    expect(
      service.browserProfileService.isLoginRequired
    ).not.toHaveBeenCalled();
    expect(service.browserProfileService.probe).not.toHaveBeenCalled();

    session.verificationClearedAt = new Date(Date.now() - 7_000);
    service.browserProfileService.getCookieDiagnostics.mockResolvedValue({
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
    });
    service.browserProfileService.probe.mockResolvedValue({
      state: 'transient',
      finalUrl: 'https://www.douyin.com/',
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
      reason: 'still settling',
    });

    await service.checkBrowserLoginSession(session);

    expect(service.browserProfileService.isLoginRequired).toHaveBeenCalledTimes(
      1
    );
    expect(service.browserProfileService.probe).toHaveBeenCalledTimes(1);
  });

  it('logs out the browser profile and records an explicit expired state', async () => {
    const service = createService();

    await service.clear();

    expect(service.browserProfileService.logout).toHaveBeenCalledTimes(1);
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'expired',
        cookieNames: [],
        lastValidationCode: 'SESSION_EXPIRED',
      })
    );
  });

  it('orders a delayed runtime challenge before a newer logout operation', async () => {
    const service = createService();
    const transitionWhenIdle = service.credentialRepository.transitionWhenIdle;
    let runtimeStarted!: () => void;
    const started = new Promise<void>(resolve => {
      runtimeStarted = resolve;
    });
    let releaseRuntime!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseRuntime = resolve;
    });
    service.credentialRepository.transitionWhenIdle = jest.fn(
      async transition => {
        runtimeStarted();
        await gate;
        return transitionWhenIdle(transition);
      }
    );

    const runtime = service.markRuntimeChallenge('old challenge');
    await started;
    let logoutFinished = false;
    const logout = service.clear().then(() => {
      logoutFinished = true;
    });
    await Promise.resolve();

    expect(logoutFinished).toBe(false);

    releaseRuntime();
    await Promise.all([runtime, logout]);

    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'expired',
        operationId: null,
        lastValidationError: 'Signed out by user',
      })
    );
  });

  it('rejects a valid profile probe that finishes after logout', async () => {
    const service = createService();
    const target = createTarget();
    service.browserProfileService.createLoginTarget.mockResolvedValue(target);
    let probeStarted!: () => void;
    const started = new Promise<void>(resolve => {
      probeStarted = resolve;
    });
    let releaseProbe!: (value: any) => void;
    const pendingProbe = new Promise<any>(resolve => {
      releaseProbe = resolve;
    });
    const validProbe = {
      state: 'valid',
      finalUrl: 'https://www.douyin.com/',
      cookieNames: ['sessionid'],
      authenticatedCookieNames: ['sessionid'],
      accountFingerprint: 'a'.repeat(64),
    };
    service.browserProfileService.probe
      .mockImplementationOnce(async () => {
        probeStarted();
        return pendingProbe;
      })
      .mockResolvedValueOnce(validProbe);

    const verification = service.verifyCookie();
    await started;
    await service.clear();
    releaseProbe(validProbe);

    await expect(verification).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: 'Douyin account validation was superseded',
      })
    );
    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'expired',
        operationId: null,
        lastValidationError: 'Signed out by user',
      })
    );
    expect(service.browserProfileService.closeTarget).toHaveBeenCalledWith(
      target
    );
  });

  it('records a runtime browser challenge without treating public failures as auth', async () => {
    const service = createService();

    await service.markRuntimeChallenge('captcha page');

    expect(service.getCredential()).toEqual(
      expect.objectContaining({
        state: 'challenged',
        lastValidationCode: 'CAPTCHA_REQUIRED',
        lastValidationError: 'captcha page',
      })
    );
  });

  it('detects Douyin secondary identity verification text', () => {
    expect(
      isDouyinIdentityVerificationText(
        '身份验证 为保障账号安全 接收短信验证码 手机刷脸验证'
      )
    ).toBe(true);
    expect(isDouyinIdentityVerificationText('登录后即可查看推荐内容')).toBe(
      false
    );
  });
});
