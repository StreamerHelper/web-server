import { DouyinAuthService } from '../../src/service/douyin-auth.service';

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
});
