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
        cookieNames:
          transition.cookieNames ?? credential?.cookieNames ?? [],
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
      beginOperation: jest.fn(async (operationId, transition) => {
        generation = Math.max(generation, credential?.generation || 0) + 1;
        return {
          credential: applyTransition(transition, operationId, generation),
          operation: { id: operationId, generation },
        };
      }),
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
      invalidateOperation: jest.fn(async transition => {
        generation = Math.max(generation, credential?.generation || 0) + 1;
        return applyTransition(transition, null, generation);
      }),
    };
    service.browserProfileService = {
      createLoginTarget: jest.fn(),
      closeTarget: jest.fn().mockResolvedValue(undefined),
      probe: jest.fn(),
      logout: jest.fn().mockResolvedValue(undefined),
      openLoginPanel: jest.fn().mockResolvedValue(true),
      detectChallenge: jest.fn().mockResolvedValue(undefined),
      getCookieDiagnostics: jest.fn(),
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
    service.browserProfileService.detectChallenge.mockResolvedValue(
      'second_verification'
    );

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('verification_required');
    expect(session.verification).toEqual(
      expect.objectContaining({
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
    });

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('authenticated');
    expect(service.getCredential().state).toBe('valid');
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
    service.browserProfileService.detectChallenge.mockImplementation(
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
      service.browserProfileService.detectChallenge
    ).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce({
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

    expect(service.browserProfileService.openLoginPanel).not.toHaveBeenCalledWith(
      lateTarget.page
    );
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
      target.page
    );
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
