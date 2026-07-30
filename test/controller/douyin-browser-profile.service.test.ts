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

  const createValidationPage = (browserContext: any) => {
    const validationPage = {
      url: jest.fn().mockReturnValue('https://www.douyin.com/'),
      browserContext: jest.fn().mockReturnValue(browserContext),
      evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(undefined),
      setViewport: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
      close: jest.fn().mockResolvedValue(undefined),
    };
    browserContext.newPage = jest.fn().mockResolvedValue(validationPage);
    return validationPage;
  };

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

  it('ignores a preloaded captcha frame when its iframe is hidden', async () => {
    const service = createService();
    const mainFrame = {
      parentFrame: jest.fn().mockReturnValue(null),
      evaluate: jest.fn().mockResolvedValue({
        text: '扫码登录 验证码登录 密码登录',
        title: '抖音精选电脑版',
        html: '<script src="secsdk-captcha/index.js"></script>',
      }),
    };
    const hiddenFrameElement = {
      isVisible: jest.fn().mockResolvedValue(false),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const hiddenCaptchaFrame = {
      parentFrame: jest.fn().mockReturnValue(mainFrame),
      frameElement: jest.fn().mockResolvedValue(hiddenFrameElement),
      evaluate: jest.fn().mockResolvedValue({
        text: '',
        title: 'RMC NoCaptcha',
        html: '',
      }),
    };
    const page = {
      frames: () => [mainFrame, hiddenCaptchaFrame],
    };

    await expect(service.detectChallenge(page)).resolves.toBeUndefined();
    expect(hiddenFrameElement.isVisible).toHaveBeenCalledTimes(1);
    expect(hiddenCaptchaFrame.evaluate).not.toHaveBeenCalled();
  });

  it('recognizes the active SMS code step without an identity heading', async () => {
    const service = createService();
    const input = {
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    service.findActiveVerificationCodeInput = jest
      .fn()
      .mockResolvedValue(input);
    const page = {
      frames: () => [
        {
          evaluate: jest.fn().mockResolvedValue({
            text: '接收短信验证码 短信已发送至 187****09 重新发送 验证',
            title: '',
            html: '',
          }),
        },
      ],
    };

    await expect(service.detectVerificationState(page)).resolves.toEqual({
      challenge: 'second_verification',
      awaitingCode: true,
    });
    expect(input.dispose).toHaveBeenCalledTimes(1);
  });

  it('fills the hit-testable SMS input instead of the covered login input', async () => {
    const service = createService();
    const scope = globalThis as any;
    const originalGlobals = {
      document: scope.document,
      innerWidth: scope.innerWidth,
      innerHeight: scope.innerHeight,
      getComputedStyle: scope.getComputedStyle,
      HTMLInputElement: scope.HTMLInputElement,
    };
    const body = {
      innerText:
        '接收短信验证码 短信已发送至 187****09 重新发送 验证 选择其他验证方式',
      parentElement: null,
    };
    const createInput = (left: number, parentElement: any) =>
      ({
        placeholder: '请输入验证码',
        name: 'button-input',
        disabled: false,
        parentElement,
        getAttribute: jest.fn().mockReturnValue(null),
        getBoundingClientRect: () => ({
          left,
          top: 100,
          right: left + 100,
          bottom: 120,
          width: 100,
          height: 20,
        }),
        contains: jest.fn().mockReturnValue(false),
        dispatchEvent: jest.fn(),
        focus: jest.fn(),
      } as any);
    const background = createInput(100, {
      innerText: '验证码登录 获取验证码 登录',
      parentElement: body,
    });
    const verification = createInput(400, {
      innerText: body.innerText,
      parentElement: body,
    });
    const cover = {};
    const document = {
      body,
      activeElement: null,
      querySelectorAll: jest.fn().mockReturnValue([background, verification]),
      elementFromPoint: jest.fn((x: number) =>
        x < 300 ? cover : verification
      ),
    };
    class FakeInput {}
    Object.defineProperty(FakeInput.prototype, 'value', {
      set(value) {
        (this as any).storedValue = value;
      },
    });
    scope.document = document;
    scope.innerWidth = 1_000;
    scope.innerHeight = 800;
    scope.getComputedStyle = () => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
    });
    scope.HTMLInputElement = FakeInput;

    const frame = {
      evaluateHandle: jest.fn(async callback => {
        const node = callback();
        const handle: any = {
          asElement: () => (node ? handle : null),
          evaluate: jest.fn(async (evaluate, value) => evaluate(node, value)),
          dispose: jest.fn().mockResolvedValue(undefined),
        };
        return handle;
      }),
    };

    try {
      await expect(
        service.fillVerificationCode({ frames: () => [frame] }, '123456')
      ).resolves.toBe(true);
      expect(background.storedValue).toBeUndefined();
      expect(verification.storedValue).toBe('123456');
      expect(verification.focus).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(originalGlobals)) {
        if (value === undefined) {
          delete scope[key];
        } else {
          scope[key] = value;
        }
      }
    }
  });

  it('detects captcha runtime markers only inside an active child frame', async () => {
    const service = createService();
    const mainFrame = {
      parentFrame: jest.fn().mockReturnValue(null),
      evaluate: jest.fn().mockResolvedValue({
        text: '抖音首页',
        title: '抖音',
        html: '<script src="secsdk-captcha/index.js"></script>',
      }),
    };
    const frameElement = {
      isVisible: jest.fn().mockResolvedValue(true),
      evaluate: jest.fn().mockResolvedValue(true),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const activeCaptchaFrame = {
      parentFrame: jest.fn().mockReturnValue(mainFrame),
      frameElement: jest.fn().mockResolvedValue(frameElement),
      evaluate: jest.fn().mockResolvedValue({
        text: '',
        title: '',
        html: '<script src="secsdk-captcha/index.js"></script>',
      }),
    };
    const page = {
      frames: () => [mainFrame, activeCaptchaFrame],
    };

    await expect(service.detectChallenge(page)).resolves.toBe('captcha');
  });

  it('ignores a captcha frame that is rendered but not active', async () => {
    const service = createService();
    const mainFrame = {
      parentFrame: jest.fn().mockReturnValue(null),
      evaluate: jest.fn().mockResolvedValue({
        text: '抖音首页',
        title: '抖音',
        html: '',
      }),
    };
    const frameElement = {
      isVisible: jest.fn().mockResolvedValue(true),
      evaluate: jest.fn().mockResolvedValue(false),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const inactiveCaptchaFrame = {
      parentFrame: jest.fn().mockReturnValue(mainFrame),
      frameElement: jest.fn().mockResolvedValue(frameElement),
      evaluate: jest.fn().mockResolvedValue({
        text: '',
        title: 'RMC NoCaptcha',
        html: '',
      }),
    };
    const page = {
      frames: () => [mainFrame, inactiveCaptchaFrame],
    };

    await expect(service.detectChallenge(page)).resolves.toBeUndefined();
    expect(inactiveCaptchaFrame.evaluate).not.toHaveBeenCalled();
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

  it('validates identity in a sibling page without navigating the interactive login page', async () => {
    const service = createService();
    const response = { status: () => 200 };
    const browserContext = {
      cookies: jest
        .fn()
        .mockResolvedValue([
          createCookie('sessionid', 'secret', '.douyin.com', 1_800_000_000),
        ]),
    };
    const validationPage = createValidationPage(browserContext);
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
      accountFingerprint: 'a'.repeat(64),
      loginRequired: false,
    });

    const result = await service.probe(page, '123456');

    expect(result).toEqual(
      expect.objectContaining({
        state: 'valid',
        statusCode: 200,
        accountFingerprint: 'a'.repeat(64),
        authenticatedCookieNames: ['sessionid'],
      })
    );
    expect((browserContext as any).newPage).toHaveBeenCalledTimes(1);
    expect(service.navigate).toHaveBeenCalledWith(
      validationPage,
      'https://www.douyin.com/',
      expect.any(Number)
    );
    expect(service.navigate).not.toHaveBeenCalledWith(
      page,
      expect.any(String),
      expect.any(Number)
    );
    expect(validationPage.close).toHaveBeenCalledTimes(1);
  });

  it('does not accept an identity payload from a failed HTTP response', async () => {
    const service = createService();
    const browserContext = {
      cookies: jest
        .fn()
        .mockResolvedValue([
          createCookie('sessionid', 'secret', '.douyin.com'),
        ]),
    };
    const validationPage = createValidationPage(browserContext);
    const page = {
      url: () => 'https://www.douyin.com/',
      browserContext: () => browserContext,
    };
    jest.spyOn(service, 'detectChallenge').mockResolvedValue(undefined);
    jest.spyOn(service, 'isLoginRequired').mockResolvedValue(false);
    service.navigate = jest.fn().mockResolvedValue({ status: () => 500 });
    service.fetchSelfProfileState = jest.fn().mockResolvedValue({
      httpStatus: 500,
      statusCode: 0,
      hasStableUserId: true,
      loginRequired: false,
    });

    const result = await service.probe(page);

    expect(result).toEqual(
      expect.objectContaining({
        state: 'transient',
        statusCode: 500,
        reason: 'Douyin account endpoint returned HTTP 500',
      })
    );
    expect(validationPage.close).toHaveBeenCalledTimes(1);
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
      const validationPage = createValidationPage(browserContext);
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
      expect(validationPage.close).toHaveBeenCalledTimes(1);
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
    const validationPage = createValidationPage(browserContext);
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
    expect(validationPage.close).toHaveBeenCalledTimes(1);
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
          accountFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          loginRequired: false,
        })
      );
      expect(JSON.stringify(result)).not.toContain('private-stable-id');
      expect(JSON.stringify(result)).not.toContain('private-profile-name');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('does not use the editable unique_id handle as an account identity', async () => {
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
                unique_id: 'editable-handle',
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
          hasStableUserId: false,
          accountFingerprint: undefined,
        })
      );
      expect(JSON.stringify(result)).not.toContain('editable-handle');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('cleans only stale managed pages and leaves another live worker page alone', async () => {
    const service = createService();
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const activeMarker = `streamer-helper:douyin:${now - 30 * 60_000}:active`;
    const recentMarker = `streamer-helper:douyin:${now - 60_000}:recent`;
    const staleMarker = `streamer-helper:douyin:${now - 16 * 60_000}:stale`;
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

  it('discovers and selects visible verification methods across frames', async () => {
    const service = createService();
    const createHandle = (matched: boolean) => {
      const target = {
        click: jest.fn().mockResolvedValue(undefined),
      };
      return {
        target,
        handle: {
          asElement: jest.fn().mockReturnValue(matched ? target : null),
          dispose: jest.fn().mockResolvedValue(undefined),
        },
      };
    };
    const firstFrame = {
      evaluateHandle: jest.fn().mockImplementation(() => {
        return createHandle(false).handle;
      }),
      evaluate: jest.fn().mockResolvedValue(false),
    };
    const secondFrame = {
      evaluateHandle: jest.fn().mockImplementation((_fn, labels) => {
        const matched =
          labels.includes('接收短信验证码') || labels.includes('手机刷脸认证');
        return createHandle(matched).handle;
      }),
      evaluate: jest.fn().mockImplementation((_fn, value) => {
        return value === '123456';
      }),
    };
    const page = {
      frames: () => [firstFrame, secondFrame],
    };

    await expect(
      service.getAvailableVerificationMethods(page)
    ).resolves.toEqual(['receive_sms', 'face']);
    await expect(service.selectVerificationMethod(page, 'face')).resolves.toBe(
      true
    );
    const verificationInput = {
      evaluate: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    service.findActiveVerificationCodeInput = jest
      .fn()
      .mockResolvedValue(verificationInput);
    await expect(service.fillVerificationCode(page, '123456')).resolves.toBe(
      true
    );
    expect(verificationInput.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      '123456'
    );
    expect(verificationInput.dispose).toHaveBeenCalledTimes(1);
    await expect(
      service.fillVerificationCode(page, 'bad-code')
    ).rejects.toThrow('must contain 4 to 8 digits');
  });

  it('ignores hidden duplicate verification options and clicks the active panel', async () => {
    const service = createService();
    const originalDocument = (globalThis as any).document;
    const originalInnerWidth = (globalThis as any).innerWidth;
    const originalInnerHeight = (globalThis as any).innerHeight;
    const originalGetComputedStyle = (globalThis as any).getComputedStyle;
    const defaultStyle = {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
    };
    const body: any = {
      parentElement: null,
      style: defaultStyle,
    };
    const createNode = (
      text: string,
      left: number,
      parentElement: any,
      clickable = false,
      style = defaultStyle
    ) => {
      const node: any = {
        innerText: text,
        textContent: text,
        parentElement,
        style,
        disabled: false,
        className: '',
        clickable,
        click: jest.fn().mockResolvedValue(undefined),
        getAttribute: jest.fn().mockReturnValue(null),
        getBoundingClientRect: () => ({
          left,
          top: 100,
          right: left + 120,
          bottom: 140,
          width: 120,
          height: 40,
        }),
        contains(other: any) {
          let current = other;
          while (current) {
            if (current === node) {
              return true;
            }
            current = current.parentElement;
          }
          return false;
        },
        closest() {
          let current: any = node;
          while (current) {
            if (current.clickable) {
              return current;
            }
            current = current.parentElement;
          }
          return null;
        },
      };
      return node;
    };

    const hiddenPanel = createNode('', 10, body, false, {
      ...defaultStyle,
      opacity: '0',
    });
    const labels = ['接收短信验证码', '手机刷脸认证', '发送短信验证'];
    const hiddenButtons = labels.map((label, index) =>
      createNode(label, 20 + index * 140, hiddenPanel, true)
    );
    const hiddenLabels = hiddenButtons.map((button, index) =>
      createNode(labels[index], 20 + index * 140, button)
    );
    const activeButtons = labels.map((label, index) =>
      createNode(label, 500 + index * 140, body, true)
    );
    const activeLabels = activeButtons.map((button, index) =>
      createNode(labels[index], 500 + index * 140, button, false, {
        ...defaultStyle,
        pointerEvents: 'none',
      })
    );
    const allLabels = [...hiddenLabels, ...activeLabels];
    const document = {
      querySelectorAll: jest.fn().mockReturnValue(allLabels),
      elementFromPoint: jest.fn((x: number) => {
        const index = Math.floor((x - 500) / 140);
        return activeButtons[index] || null;
      }),
    };
    const frame = {
      evaluateHandle: jest.fn(async (callback, values) => {
        const target = callback(values);
        return {
          asElement: jest.fn().mockReturnValue(target),
          dispose: jest.fn().mockResolvedValue(undefined),
        };
      }),
    };
    const page = {
      frames: () => [frame],
    };
    service.waitForActiveVerificationCodeInput = jest
      .fn()
      .mockResolvedValue(true);

    try {
      (globalThis as any).document = document;
      (globalThis as any).innerWidth = 1280;
      (globalThis as any).innerHeight = 800;
      (globalThis as any).getComputedStyle = (node: any) =>
        node.style || defaultStyle;

      await expect(
        service.getAvailableVerificationMethods(page)
      ).resolves.toEqual(['receive_sms', 'face', 'send_sms']);
      await expect(
        service.selectVerificationMethod(page, 'receive_sms')
      ).resolves.toBe(true);
      await expect(
        service.selectVerificationMethod(page, 'face')
      ).resolves.toBe(true);
      await expect(
        service.selectVerificationMethod(page, 'send_sms')
      ).resolves.toBe(true);

      for (const button of hiddenButtons) {
        expect(button.click).not.toHaveBeenCalled();
      }
      for (const button of activeButtons) {
        expect(button.click).toHaveBeenCalledTimes(1);
      }
    } finally {
      (globalThis as any).document = originalDocument;
      (globalThis as any).innerWidth = originalInnerWidth;
      (globalThis as any).innerHeight = originalInnerHeight;
      (globalThis as any).getComputedStyle = originalGetComputedStyle;
    }
  });

  it('confirms SMS selection only after the active code input appears', async () => {
    const service = createService();
    service.clickVisibleTextAcrossFrames = jest.fn().mockResolvedValue(true);
    service.waitForActiveVerificationCodeInput = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const page = {};

    await expect(
      service.selectVerificationMethod(page, 'receive_sms')
    ).resolves.toBe(false);
    await expect(
      service.selectVerificationMethod(page, 'receive_sms')
    ).resolves.toBe(true);
    expect(service.waitForActiveVerificationCodeInput).toHaveBeenCalledTimes(2);
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

  it('clears ByteDance cookies plus known and cookie-derived site storage', async () => {
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
    expect(client.send.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(client.send).toHaveBeenCalledWith(
      'Storage.clearDataForOrigin',
      expect.objectContaining({
        origin: 'https://live.douyin.com',
        storageTypes: 'all',
      })
    );
    expect(client.send).toHaveBeenCalledWith(
      'Storage.clearDataForOrigin',
      expect.objectContaining({
        origin: 'https://lf-zt.douyin.com',
        storageTypes: 'all',
      })
    );
    expect(client.send).toHaveBeenCalledWith(
      'Storage.clearDataForOrigin',
      expect.objectContaining({
        origin: 'https://douyin.com',
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
