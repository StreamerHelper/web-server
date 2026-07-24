import {
  DouyinAuthService,
  isDouyinIdentityVerificationText,
} from '../../src/service/douyin-auth.service';

describe('DouyinAuthService', () => {
  const createService = () => {
    const service = new DouyinAuthService() as any;
    service.credentialRepository = {
      findLatest: jest.fn().mockResolvedValue(null),
      saveCredential: jest.fn(async credential => ({
        ...credential,
        id: 'credential-id',
        createdAt: new Date('2026-05-28T00:00:00.000Z'),
        updatedAt: new Date('2026-05-28T00:00:00.000Z'),
      })),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    service.logger = {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };
    return service;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes copied Cookie headers and removes Set-Cookie attributes', () => {
    const service = createService();

    const normalized = service.normalizeCookieHeader(`
      Cookie: sessionid=abc; Path=/; s_v_web_id=verify_guest; ttwid=tw; HttpOnly; passport_csrf_token=csrf
    `);

    expect(normalized).toEqual({
      cookieHeader: 'sessionid=abc; ttwid=tw; passport_csrf_token=csrf',
      cookieNames: ['passport_csrf_token', 'sessionid', 'ttwid'],
    });
  });

  it('saves a verified Douyin Cookie without returning the secret value', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('<html><title>抖音直播</title></html>', { status: 200 })
      );
    const service = createService();

    const result = await service.saveCookie('sessionid=abc; ttwid=tw', {
      verify: true,
    });

    expect(service.credentialRepository.saveCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        cookieHeader: 'sessionid=abc; ttwid=tw',
        cookieNames: ['sessionid', 'ttwid'],
        lastValidationError: null,
      })
    );
    expect(result.status).toEqual(
      expect.objectContaining({
        isAuthenticated: true,
        source: 'database',
        cookieNames: ['sessionid', 'ttwid'],
      })
    );
    expect(JSON.stringify(result)).not.toContain('sessionid=abc');
  });

  it('rejects Cookie values that still hit Douyin captcha', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('<html><title>安全验证</title></html>', { status: 200 })
      );
    const service = createService();

    await expect(
      service.saveCookie('sessionid=abc; ttwid=tw', { verify: true })
    ).rejects.toThrow('Douyin returned a captcha page');
    expect(service.credentialRepository.saveCredential).not.toHaveBeenCalled();
  });

  it('rejects empty verification responses', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    const service = createService();

    await expect(
      service.saveCookie('sessionid=abc; ttwid=tw', { verify: true })
    ).rejects.toThrow('Douyin returned an empty verification response');
    expect(service.credentialRepository.saveCredential).not.toHaveBeenCalled();
  });

  it('requires room data when verifying a specific live room', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('<html><title>抖音直播</title></html>', { status: 200 })
      );
    const service = createService();

    await expect(
      service.saveCookie('sessionid=abc; ttwid=tw', {
        verify: true,
        roomId: '123456',
      })
    ).rejects.toThrow(
      'Douyin room info was not found in verification response'
    );
    expect(service.credentialRepository.saveCredential).not.toHaveBeenCalled();
  });

  it('reports database credential status without exposing Cookie content', async () => {
    const service = createService();
    service.credentialRepository.findLatest.mockResolvedValue({
      cookieHeader: 'sessionid=secret',
      cookieNames: ['sessionid'],
      verifiedAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:01:00.000Z'),
      lastValidationError: null,
    });

    const status = await service.getStatus();

    expect(status).toEqual({
      isAuthenticated: true,
      source: 'database',
      cookieNames: ['sessionid'],
      verifiedAt: new Date('2026-05-28T00:00:00.000Z'),
      updatedAt: new Date('2026-05-28T00:01:00.000Z'),
      lastValidationError: null,
    });
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  it('builds browser Cookie headers from Douyin related domains only', () => {
    const service = createService();

    const normalized = service.buildCookieHeaderFromBrowserCookies([
      { name: 'sessionid', value: 'abc', domain: '.douyin.com' },
      { name: 'ttwid', value: 'tw', domain: 'live.douyin.com' },
      { name: 'webcast', value: 'cast', domain: '.webcast.amemv.com' },
      { name: 'foreign', value: 'ignore', domain: '.example.com' },
    ] as any);

    expect(normalized).toEqual({
      cookieHeader: 'sessionid=abc; ttwid=tw; webcast=cast',
      cookieNames: ['sessionid', 'ttwid', 'webcast'],
    });
  });

  it('detects authenticated Douyin browser Cookies', () => {
    const service = createService();

    expect(
      service.hasAuthenticatedDouyinCookies([
        { name: 'ttwid', value: 'tw', domain: '.douyin.com' },
      ] as any)
    ).toBe(false);
    expect(
      service.hasAuthenticatedDouyinCookies([
        { name: 'sessionid', value: 'abc', domain: '.douyin.com' },
      ] as any)
    ).toBe(true);
    expect(
      service.hasAuthenticatedDouyinCookies([
        { name: 'sessionid', value: 'abc', domain: '.example.com' },
      ] as any)
    ).toBe(false);
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

  it('keeps the browser session interactive through secondary verification', async () => {
    const service = createService() as any;
    const page = {
      evaluate: jest
        .fn()
        .mockResolvedValueOnce(
          '身份验证 为保障账号安全 接收短信验证码 手机刷脸验证'
        ),
    };
    const session: any = {
      id: 'session-id',
      status: 'waiting',
      createdAt: new Date('2026-07-24T00:00:00.000Z'),
      updatedAt: new Date('2026-07-24T00:00:00.000Z'),
      expiresAt: new Date(Date.now() + 60_000),
      page,
      browserContext: {
        cookies: jest.fn().mockResolvedValue([]),
      },
    };

    await service.checkBrowserLoginSession(session);
    expect(session.status).toBe('verification_required');
    expect(session.verification).toEqual(
      expect.objectContaining({
        stage: 'choose_method',
        availableMethods: ['receive_sms', 'face', 'send_sms'],
      })
    );
    await service.checkBrowserLoginSession(session);
    expect(session.status).toBe('verification_required');
  });

  it('keeps polling while Douyin replaces the page execution context', async () => {
    const service = createService() as any;
    const session: any = {
      id: 'session-id',
      status: 'waiting',
      createdAt: new Date('2026-07-24T00:00:00.000Z'),
      updatedAt: new Date('2026-07-24T00:00:00.000Z'),
      expiresAt: new Date(Date.now() + 60_000),
      page: {
        evaluate: jest
          .fn()
          .mockRejectedValue(
            new Error(
              'Execution context was destroyed, most likely because of a navigation.'
            )
          ),
      },
      browserContext: {
        cookies: jest.fn().mockResolvedValue([]),
      },
    };

    await service.checkBrowserLoginSession(session);

    expect(session.status).toBe('waiting');
    expect(session.error).toBeUndefined();
    expect(service.logger.debug).toHaveBeenCalledWith(
      'Douyin login page is still navigating',
      { sessionId: session.id }
    );
  });

  it('retries a detached-frame navigation once', async () => {
    const service = createService() as any;
    service.sleep = jest.fn().mockResolvedValue(undefined);
    const page = {
      goto: jest
        .fn()
        .mockRejectedValueOnce(new Error('Navigating frame was detached'))
        .mockResolvedValueOnce(undefined),
    };

    await service.navigateToDouyinLoginPage(page, 'https://www.douyin.com/');

    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(service.sleep).toHaveBeenCalledWith(1000);
  });

  it('selects the default SMS method through visible Douyin text', async () => {
    const service = createService() as any;
    service.sleep = jest.fn().mockResolvedValue(undefined);
    service.clickVisibleElementByText = jest.fn().mockResolvedValue(true);
    const evaluate = jest
      .fn()
      .mockResolvedValueOnce('身份验证 请输入短信验证码');
    const session = {
      id: 'session-id',
      status: 'verification_required',
      createdAt: new Date('2026-07-24T00:00:00.000Z'),
      updatedAt: new Date('2026-07-24T00:00:00.000Z'),
      expiresAt: new Date(Date.now() + 60_000),
      page: {
        url: () => 'https://www.douyin.com/jingxuan',
        evaluate,
        keyboard: { press: jest.fn() },
      },
      verification: {
        stage: 'choose_method',
        availableMethods: ['receive_sms', 'face', 'send_sms'],
      },
    };
    service.browserLoginSessions.set(session.id, session);

    const status = await service.interactWithBrowserLogin(session.id, {
      type: 'select_verification_method',
      method: 'receive_sms',
    });

    expect(service.clickVisibleElementByText).toHaveBeenCalledWith(
      session.page,
      ['接收短信验证码']
    );
    expect(status.verification).toEqual(
      expect.objectContaining({
        stage: 'awaiting_code',
        method: 'receive_sms',
      })
    );
    expect(status.status).toBe('verification_required');
    expect(status.screenshotUpdatedAt).toBeInstanceOf(Date);
  });

  it('submits an SMS code through the structured verification proxy', async () => {
    const service = createService() as any;
    service.sleep = jest.fn().mockResolvedValue(undefined);
    service.fillVisibleVerificationCode = jest.fn().mockResolvedValue(true);
    service.clickVisibleElementByText = jest.fn().mockResolvedValue(true);
    const press = jest.fn().mockResolvedValue(undefined);
    const evaluate = jest.fn().mockResolvedValueOnce('身份验证 验证码错误');
    const session = {
      id: 'session-id',
      status: 'verification_required',
      createdAt: new Date('2026-07-24T00:00:00.000Z'),
      updatedAt: new Date('2026-07-24T00:00:00.000Z'),
      expiresAt: new Date(Date.now() + 60_000),
      page: {
        url: () => 'https://www.douyin.com/',
        evaluate,
        keyboard: { press },
      },
      browserContext: {
        cookies: jest.fn().mockResolvedValue([]),
      },
      verification: {
        stage: 'awaiting_code',
        method: 'receive_sms',
        availableMethods: [],
      },
    };
    service.browserLoginSessions.set(session.id, session);

    await service.interactWithBrowserLogin(session.id, {
      type: 'submit_verification_code',
      code: '123456',
    });

    expect(service.fillVisibleVerificationCode).toHaveBeenCalledWith(
      session.page,
      '123456'
    );
    expect(press).not.toHaveBeenCalled();
    expect(session.verification.stage).toBe('awaiting_code');
    await expect(
      service.interactWithBrowserLogin(session.id, {
        type: 'submit_verification_code',
        code: 'not-a-code',
      })
    ).rejects.toThrow('must contain 4 to 8 digits');

    session.page.url = () => 'https://example.com/';
    await expect(
      service.interactWithBrowserLogin(session.id, {
        type: 'submit_verification_code',
        code: '654321',
      })
    ).rejects.toThrow('restricted to Douyin pages');
  });
});
