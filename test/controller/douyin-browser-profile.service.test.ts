import {
  DouyinBrowserProfileService,
  DouyinBrowserLoginTarget,
} from '../../src/service/douyin-browser-profile.service';

describe('DouyinBrowserProfileService', () => {
  const originalBrowserEndpoint = process.env.DOUYIN_BROWSER_ENDPOINT;

  const createService = () => {
    const service = new DouyinBrowserProfileService() as any;
    service.logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    return service;
  };

  const createCookie = (
    name: string,
    value: string,
    domain: string,
    expires = -1
  ) =>
    ({
      name,
      value,
      domain,
      path: '/',
      expires,
      size: name.length + value.length,
      httpOnly: true,
      secure: true,
      session: expires < 0,
      sameSite: 'Lax',
      priority: 'Medium',
      sameParty: false,
      sourceScheme: 'Secure',
    } as any);

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalBrowserEndpoint === undefined) {
      delete process.env.DOUYIN_BROWSER_ENDPOINT;
    } else {
      process.env.DOUYIN_BROWSER_ENDPOINT = originalBrowserEndpoint;
    }
  });

  it('uses the persistent default context for a remote browser without overriding UA', async () => {
    process.env.DOUYIN_BROWSER_ENDPOINT =
      'ws://browser:9222/devtools/browser/browser-id';
    const service = createService();
    const page = {
      goto: jest.fn().mockResolvedValue(null),
      setViewport: jest.fn().mockResolvedValue(undefined),
      setUserAgent: jest.fn().mockResolvedValue(undefined),
      evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(undefined),
    };
    const browserContext = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn(),
    };
    const browser = {
      defaultBrowserContext: jest.fn(() => browserContext),
      createBrowserContext: jest.fn(),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    const connect = jest.fn().mockResolvedValue(browser);
    service.importPuppeteer = jest.fn().mockResolvedValue({ connect });
    service.resolveRemoteBrowserConnection = jest.fn().mockResolvedValue({
      browserWSEndpoint: 'ws://browser:9222/devtools/browser/browser-id',
    });

    const target = await service.createLoginTarget('123456');

    expect(browser.defaultBrowserContext).toHaveBeenCalledTimes(1);
    expect(browser.createBrowserContext).not.toHaveBeenCalled();
    expect(browserContext.newPage).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(
      'https://live.douyin.com/123456',
      expect.objectContaining({ waitUntil: 'domcontentloaded' })
    );
    expect(page.setViewport).toHaveBeenCalled();
    expect(page.setUserAgent).not.toHaveBeenCalled();
    expect(target).toEqual(
      expect.objectContaining({
        browser,
        browserContext,
        page,
        ownsBrowser: false,
      })
    );
  });

  it('closes only the page and remote connection, never the default context', async () => {
    const service = createService();
    const page = {
      isClosed: jest.fn().mockReturnValue(false),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const browserContext = {
      close: jest.fn().mockResolvedValue(undefined),
    };
    const browser = {
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    await service.closeTarget({
      page,
      browserContext,
      browser,
      ownsBrowser: false,
    } as any);

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
    expect(browserContext.close).not.toHaveBeenCalled();
  });

  it('closes a locally owned browser but still never closes its default context directly', async () => {
    const service = createService();
    const page = {
      isClosed: jest.fn().mockReturnValue(false),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const browserContext = {
      close: jest.fn().mockResolvedValue(undefined),
    };
    const browser = {
      close: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    await service.closeTarget({
      page,
      browserContext,
      browser,
      ownsBrowser: true,
    } as any);

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.disconnect).not.toHaveBeenCalled();
    expect(browserContext.close).not.toHaveBeenCalled();
  });

  it('detects secondary verification inside a cross-origin frame before captcha', async () => {
    const service = createService();
    const normalFrame = {
      evaluate: jest.fn().mockResolvedValue({
        text: '抖音首页',
        title: '抖音',
        html: '',
      }),
    };
    const verificationFrame = {
      evaluate: jest.fn().mockResolvedValue({
        text: '身份验证 为保障账号安全 接收短信验证码 手机刷脸验证',
        title: '安全验证',
        html: '<script src="captcha/index.js"></script>',
      }),
    };
    const page = {
      frames: () => [normalFrame, verificationFrame],
    };

    await expect(service.detectChallenge(page)).resolves.toBe(
      'second_verification'
    );
  });

  it('detects a captcha script inside a child frame', async () => {
    const service = createService();
    const page = {
      frames: () => [
        {
          evaluate: jest.fn().mockResolvedValue({
            text: '请完成验证后继续',
            title: '验证码中间页',
            html: '<script src="secsdk-captcha/index.js"></script>',
          }),
        },
      ],
      content: jest.fn(),
      title: jest.fn(),
    };

    await expect(service.detectChallenge(page)).resolves.toBe('captcha');
  });

  it('detects a login prompt inside a child frame', async () => {
    const service = createService();
    const page = {
      url: () => 'https://www.douyin.com/',
      frames: () => [
        {
          evaluate: jest.fn().mockResolvedValue({
            text: '使用手机号登录或扫码登录',
            title: '登录',
            html: '',
          }),
        },
      ],
    };

    await expect(service.isLoginRequired(page)).resolves.toBe(true);
  });

  it('classifies provisional login cookies plus verification UI as challenged', async () => {
    const service = createService();
    const browserContext = {
      cookies: jest
        .fn()
        .mockResolvedValue([
          createCookie('sessionid', 'provisional', '.douyin.com'),
        ]),
    };
    const page = {
      url: () => 'https://www.douyin.com/',
      browserContext: () => browserContext,
    };
    jest
      .spyOn(service, 'detectChallenge')
      .mockResolvedValue('second_verification');

    const result = await service.probe(page);

    expect(result).toEqual(
      expect.objectContaining({
        state: 'challenged',
        challenge: 'second_verification',
        authenticatedCookieNames: ['sessionid'],
      })
    );
  });

  it('marks a profile valid only when the account endpoint returns a stable identity', async () => {
    const service = createService();
    const response = { status: () => 200 };
    const browserContext = {
      cookies: jest
        .fn()
        .mockResolvedValue([
          createCookie('sessionid', 'secret', '.douyin.com', 1_800_000_000),
        ]),
    };
    const page = {
      url: () => 'https://live.douyin.com/123456',
      browserContext: () => browserContext,
      content: jest
        .fn()
        .mockResolvedValue(
          '<script>self.__pace_f.push("roomInfo roomStore")</script>'
        ),
    };
    jest.spyOn(service, 'detectChallenge').mockResolvedValue(undefined);
    jest.spyOn(service, 'isLoginRequired').mockResolvedValue(false);
    service.navigate = jest.fn().mockResolvedValue(response);
    service.fetchSelfProfileState = jest.fn().mockResolvedValue({
      httpStatus: 200,
      statusCode: 0,
      hasStableUserId: true,
      loginRequired: false,
    });

    const result = await service.probe(page, '123456');

    expect(result).toEqual(
      expect.objectContaining({
        state: 'valid',
        statusCode: 200,
        authenticatedCookieNames: ['sessionid'],
      })
    );
    expect(service.navigate).toHaveBeenCalledWith(
      page,
      'https://www.douyin.com/',
      expect.any(Number)
    );
  });

  it.each([8, 2483])(
    'does not authenticate a stale Cookie when the account endpoint returns status %s',
    async statusCode => {
      const service = createService();
      const browserContext = {
        cookies: jest
          .fn()
          .mockResolvedValue([
            createCookie('sessionid', 'stale', '.douyin.com'),
          ]),
      };
      const page = {
        url: () => 'https://www.douyin.com/',
        browserContext: () => browserContext,
      };
      jest.spyOn(service, 'detectChallenge').mockResolvedValue(undefined);
      jest.spyOn(service, 'isLoginRequired').mockResolvedValue(false);
      service.navigate = jest.fn().mockResolvedValue({ status: () => 200 });
      service.fetchSelfProfileState = jest.fn().mockResolvedValue({
        httpStatus: 200,
        statusCode,
        hasStableUserId: false,
        loginRequired: true,
      });

      const result = await service.probe(page);

      expect(result).toEqual(
        expect.objectContaining({
          state: 'expired',
          authenticatedCookieNames: ['sessionid'],
        })
      );
    }
  );

  it('treats status zero without a stable account identity as transient', async () => {
    const service = createService();
    const browserContext = {
      cookies: jest
        .fn()
        .mockResolvedValue([
          createCookie('sessionid', 'secret', '.douyin.com'),
        ]),
    };
    const page = {
      url: () => 'https://www.douyin.com/',
      browserContext: () => browserContext,
    };
    jest.spyOn(service, 'detectChallenge').mockResolvedValue(undefined);
    jest.spyOn(service, 'isLoginRequired').mockResolvedValue(false);
    service.navigate = jest.fn().mockResolvedValue({ status: () => 200 });
    service.fetchSelfProfileState = jest.fn().mockResolvedValue({
      httpStatus: 200,
      statusCode: 0,
      hasStableUserId: false,
      loginRequired: false,
    });

    const result = await service.probe(page, '123456');

    expect(result).toEqual(
      expect.objectContaining({
        state: 'transient',
        reason: 'Douyin account endpoint did not confirm a stable identity',
      })
    );
  });

  it('keeps account identifiers and profile fields inside the browser process', async () => {
    const service = createService();
    const originalFetch = (globalThis as any).fetch;
    const page = {
      evaluate: jest.fn(async (callback, timeoutMs) => {
        (globalThis as any).fetch = jest.fn().mockResolvedValue({
          status: 200,
          text: jest.fn().mockResolvedValue(
            JSON.stringify({
              status_code: 0,
              user: {
                sec_uid: 'private-stable-id',
                nickname: 'private-profile-name',
              },
            })
          ),
        });
        return callback(timeoutMs);
      }),
    };

    try {
      const result = await service.fetchSelfProfileState(page);

      expect(result).toEqual(
        expect.objectContaining({
          httpStatus: 200,
          statusCode: 0,
          hasStableUserId: true,
          loginRequired: false,
        })
      );
      expect(JSON.stringify(result)).not.toContain('private-stable-id');
      expect(JSON.stringify(result)).not.toContain('private-profile-name');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('cleans only stale managed pages and leaves another live worker page alone', async () => {
    const service = createService();
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const activeMarker = `streamer-helper:douyin:${
      now - 30 * 60_000
    }:active`;
    const recentMarker = `streamer-helper:douyin:${now - 60_000}:recent`;
    const staleMarker = `streamer-helper:douyin:${
      now - 16 * 60_000
    }:stale`;
    service.activePageMarkers.add(activeMarker);
    const createPage = (marker: string) => ({
      evaluate: jest.fn().mockResolvedValue(marker),
      isClosed: jest.fn().mockReturnValue(false),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const activePage = createPage(activeMarker);
    const recentPage = createPage(recentMarker);
    const stalePage = createPage(staleMarker);
    const foreignPage = createPage('unmanaged-page');
    const browserContext = {
      pages: jest
        .fn()
        .mockResolvedValue([activePage, recentPage, stalePage, foreignPage]),
    };

    await service.cleanupOrphanedPages(browserContext);

    expect(stalePage.close).toHaveBeenCalledTimes(1);
    expect(activePage.close).not.toHaveBeenCalled();
    expect(recentPage.close).not.toHaveBeenCalled();
    expect(foreignPage.close).not.toHaveBeenCalled();
  });

  it('fails clearly instead of launching the same local profile concurrently', async () => {
    const service = createService();
    const launch = jest.fn();
    service.importPuppeteer = jest.fn().mockResolvedValue({ launch });
    service.getBrowserEndpoint = jest.fn().mockReturnValue('');
    service.localProfileLease = true;

    await expect(service.createBrowserTarget()).rejects.toThrow(
      'Local Douyin browser profile is already in use'
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it('selects a verification method and fills the code across frames', async () => {
    const service = createService();
    const firstFrame = {
      evaluate: jest.fn().mockResolvedValue(false),
    };
    const secondFrame = {
      evaluate: jest.fn().mockImplementation((_fn, value) => {
        return value === '接收短信验证码' || value === '123456';
      }),
    };
    const page = {
      frames: () => [firstFrame, secondFrame],
    };

    await expect(
      service.selectVerificationMethod(page, 'receive_sms')
    ).resolves.toBe(true);
    await expect(service.fillVerificationCode(page, '123456')).resolves.toBe(
      true
    );
    await expect(
      service.fillVerificationCode(page, 'bad-code')
    ).rejects.toThrow('must contain 4 to 8 digits');
  });

  it('returns cookie diagnostics without exposing values', () => {
    const service = createService();
    const diagnostics = service.buildCookieDiagnostics([
      createCookie('sessionid', 'top-secret', '.douyin.com', 1_800_000_000),
      createCookie('ttwid', 'device-secret', 'live.douyin.com'),
      createCookie('foreign', 'ignore-me', '.example.com'),
    ]);

    expect(diagnostics).toEqual({
      cookieNames: ['sessionid', 'ttwid'],
      authenticatedCookieNames: ['sessionid'],
      authExpiresAt: new Date(1_800_000_000 * 1000),
    });
    expect(JSON.stringify(diagnostics)).not.toContain('top-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('device-secret');
  });

  it('clears ByteDance cookies and all persisted site storage on logout', async () => {
    const service = createService();
    const byteDanceCookie = createCookie('sessionid', 'secret', '.douyin.com');
    const foreignCookie = createCookie('foreign', 'keep', '.example.com');
    const browserContext = {
      cookies: jest.fn().mockResolvedValue([byteDanceCookie, foreignCookie]),
      deleteCookie: jest.fn().mockResolvedValue(undefined),
    };
    const client = {
      send: jest.fn().mockResolvedValue(undefined),
      detach: jest.fn().mockResolvedValue(undefined),
    };
    const target = {
      browserContext,
      page: {
        createCDPSession: jest.fn().mockResolvedValue(client),
      },
      browser: {},
      ownsBrowser: false,
    } as unknown as DouyinBrowserLoginTarget;
    service.createBrowserTarget = jest.fn().mockResolvedValue(target);
    service.closeTarget = jest.fn().mockResolvedValue(undefined);

    await service.logout();

    expect(browserContext.deleteCookie).toHaveBeenCalledWith(byteDanceCookie);
    expect(browserContext.deleteCookie).not.toHaveBeenCalledWith(foreignCookie);
    expect(client.send).toHaveBeenCalledTimes(5);
    expect(client.send).toHaveBeenCalledWith(
      'Storage.clearDataForOrigin',
      expect.objectContaining({
        origin: 'https://live.douyin.com',
        storageTypes: 'all',
      })
    );
    expect(client.detach).toHaveBeenCalled();
    expect(service.closeTarget).toHaveBeenCalledWith(target);
  });

  it('fetches a live room through the browser and releases the target', async () => {
    const service = createService();
    const html = '<script>self.__pace_f.push("roomInfo roomStore")</script>';
    const browserContext = {
      cookies: jest.fn().mockResolvedValue([]),
    };
    const page = {
      url: () => 'https://live.douyin.com/123456',
      content: jest.fn().mockResolvedValue(html),
    };
    const target = {
      browserContext,
      page,
      browser: {},
      ownsBrowser: false,
    };
    service.createBrowserTarget = jest.fn().mockResolvedValue(target);
    service.navigate = jest.fn().mockResolvedValue({ status: () => 200 });
    service.closeTarget = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(service, 'detectChallenge').mockResolvedValue(undefined);
    jest.spyOn(service, 'isLoginRequired').mockResolvedValue(false);

    const result = await service.fetchLiveRoomPage('123456');

    expect(result).toEqual(
      expect.objectContaining({
        state: 'valid',
        html,
        statusCode: 200,
      })
    );
    expect(service.closeTarget).toHaveBeenCalledWith(target);
  });
});
