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
        )
        .mockResolvedValueOnce('请输入收到的验证码'),
    };
    const session = {
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
    await service.checkBrowserLoginSession(session);
    expect(session.status).toBe('verification_required');
  });

  it('maps normalized screenshot clicks to the browser viewport', async () => {
    const service = createService() as any;
    const click = jest.fn().mockResolvedValue(undefined);
    const session = {
      id: 'session-id',
      status: 'verification_required',
      createdAt: new Date('2026-07-24T00:00:00.000Z'),
      updatedAt: new Date('2026-07-24T00:00:00.000Z'),
      expiresAt: new Date('2026-07-24T00:10:00.000Z'),
      page: {
        url: () => 'https://www.douyin.com/jingxuan',
        viewport: () => ({ width: 390, height: 760 }),
        mouse: { click },
        keyboard: { type: jest.fn() },
      },
    };
    service.browserLoginSessions.set(session.id, session);

    const status = await service.interactWithBrowserLogin(session.id, {
      type: 'click',
      xRatio: 0.5,
      yRatio: 0.25,
    });

    expect(click).toHaveBeenCalledWith(195, 190);
    expect(status.status).toBe('verification_required');
    expect(status.screenshotUpdatedAt).toBeInstanceOf(Date);
  });

  it('types into the focused Douyin verification field only', async () => {
    const service = createService() as any;
    const type = jest.fn().mockResolvedValue(undefined);
    const session = {
      id: 'session-id',
      status: 'verification_required',
      createdAt: new Date('2026-07-24T00:00:00.000Z'),
      updatedAt: new Date('2026-07-24T00:00:00.000Z'),
      expiresAt: new Date('2026-07-24T00:10:00.000Z'),
      page: {
        url: () => 'https://www.douyin.com/',
        viewport: () => ({ width: 390, height: 760 }),
        mouse: { click: jest.fn() },
        keyboard: { type },
      },
    };
    service.browserLoginSessions.set(session.id, session);

    await service.interactWithBrowserLogin(session.id, {
      type: 'type',
      text: '123456',
    });

    expect(type).toHaveBeenCalledWith('123456', { delay: 50 });
    session.page.url = () => 'https://example.com/';
    await expect(
      service.interactWithBrowserLogin(session.id, {
        type: 'type',
        text: '654321',
      })
    ).rejects.toThrow('restricted to Douyin pages');
  });
});
