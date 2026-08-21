import { DouyinAdapter } from '../../src/platform/douyin';

const FLV_PREFIX = new Uint8Array([
  0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00,
  0x12, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
]);

function flvResponse(): Response {
  return new Response(FLV_PREFIX, { status: 200 });
}

function buildDouyinHtml(status = 2) {
  const payload = JSON.stringify([
    {
      state: {
        roomStore: {
          roomInfo: {
            web_rid: 'douyin-web-rid',
            anchor: { nickname: '备用主播名' },
            room: {
              id_str: '742000000000',
              title: '抖音直播标题',
              status,
              owner: { nickname: '抖音主播' },
              room_view_stats: { display_value: 3456 },
              stream_url: {
                default_resolution: 'HD1',
                flv_pull_url: {
                  FULL_HD1: 'https://pull.example/live_uhd.flv',
                  HD1: 'https://pull.example/live_hd.flv',
                  SD1: 'https://pull.example/live_sd.flv',
                  LD: 'https://pull.example/live_ld.flv',
                },
                hls_pull_url_map: {
                  HD1: 'https://pull.example/live_hd.m3u8',
                },
              },
            },
          },
        },
      },
    },
  ]);

  return `<html><script>self.__pace_f.push(${JSON.stringify(
    payload
  )})</script></html>`;
}

describe('DouyinAdapter', () => {
  const originalResolverUrl = process.env.DOUYIN_RESOLVER_URL;
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalResolverUrl === undefined) {
      delete process.env.DOUYIN_RESOLVER_URL;
    } else {
      process.env.DOUYIN_RESOLVER_URL = originalResolverUrl;
    }
    (DouyinAdapter as any).guestCookieCache = undefined;
    (DouyinAdapter as any).resolverCache.clear();
    (DouyinAdapter as any).offlineConfirmations.clear();
    (DouyinAdapter as any).resolverMediaCircuits.clear();
    (DouyinAdapter as any).circuits.clear();
  });

  it('extracts live status from Douyin __pace_f page data', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(buildDouyinHtml(), {
        status: 200,
      });
    });

    const adapter = new DouyinAdapter(logger);
    const status = await adapter.getStreamerStatus('douyin-web-rid');

    expect(status).toEqual({
      isLive: true,
      roomId: '742000000000',
      streamerId: 'douyin-web-rid',
      title: '抖音直播标题',
      viewerCount: 3456,
      startTime: undefined,
    });
  });

  it('selects a requested quality stream and validates it', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://live.douyin.com/')) {
          return new Response(buildDouyinHtml(), { status: 200 });
        }
        return flvResponse();
      });

    const adapter = new DouyinAdapter(logger);
    const resolved = await adapter.getStream('douyin-web-rid', 'low');

    expect(resolved.url).toBe('https://pull.example/live_ld.flv');
    expect(resolved.requestedQuality).toBe('low');
    expect(resolved.effectiveQuality).toBe('low');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://pull.example/live_ld.flv',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('validates direct Douyin room URLs without fetching room data', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');

    const adapter = new DouyinAdapter(logger);

    await expect(
      adapter.validateStreamerId('https://live.douyin.com/116422730252')
    ).resolves.toBe(true);
    await expect(
      adapter.validateStreamerId(
        'https://www.douyin.com/root/live/116422730252'
      )
    ).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed Douyin room identifiers', async () => {
    const adapter = new DouyinAdapter(logger);

    await expect(adapter.validateStreamerId('../bad-room')).resolves.toBe(
      false
    );
  });

  it('never follows redirects for non-Douyin or non-HTTPS URLs', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    const adapter = new DouyinAdapter(logger);

    await expect(
      adapter.validateStreamerId('https://127.0.0.1/internal')
    ).resolves.toBe(false);
    await expect(
      adapter.validateStreamerId('http://v.douyin.com/unsafe')
    ).resolves.toBe(false);
    await expect(
      adapter.validateStreamerId('https://notdouyin.com/root/live/742000000000')
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds an anonymous identity with a dynamically registered ttwid', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.includes('/ttwid/union/register/')) {
            return new Response('', {
              status: 200,
              headers: {
                'set-cookie': 'ttwid=dynamic-device; Path=/; HttpOnly',
              },
            });
          }
          expect(init?.headers).toEqual(
            expect.objectContaining({
              Cookie: expect.stringContaining('ttwid=dynamic-device'),
            })
          );
          expect((init?.headers as Record<string, string>).Cookie).toContain(
            'odin_ttid='
          );
          return new Response(buildDouyinHtml(), { status: 200 });
        }
      );

    const adapter = new DouyinAdapter(logger);
    await adapter.getStreamerStatus('douyin-web-rid');

    expect(fetchMock).toHaveBeenCalled();
  });

  it('uses the pinned resolver sidecar as the primary anonymous path', async () => {
    process.env.DOUYIN_RESOLVER_URL = 'http://douyin-resolver:7100';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).startsWith('http://douyin-resolver:7100')) {
            return new Response(
              JSON.stringify({
                state: 'live',
                roomId: '742000000000',
                title: 'resolver title',
                stream: {
                  url: 'https://pull.example/resolver.flv',
                  headers: {
                    'User-Agent': 'resolver-agent',
                    Cookie: 'ttwid=ephemeral',
                    Authorization: 'must-not-be-forwarded',
                  },
                  effectiveQuality: 'high',
                },
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }
          expect(String(input)).toBe('https://pull.example/resolver.flv');
          expect(init).toEqual(
            expect.objectContaining({
              method: 'GET',
              redirect: 'manual',
              headers: {
                'User-Agent': 'resolver-agent',
                Cookie: 'ttwid=ephemeral',
              },
            })
          );
          return flvResponse();
        }
      );

    const adapter = new DouyinAdapter(logger);
    const status = await adapter.getStreamerStatus('douyin-web-rid');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stream = await adapter.getStream('douyin-web-rid', 'high');

    expect(status).toEqual(
      expect.objectContaining({
        isLive: true,
        roomId: '742000000000',
        title: 'resolver title',
      })
    );
    expect(stream).toEqual(
      expect.objectContaining({
        url: 'https://pull.example/resolver.flv',
        headers: {
          'User-Agent': 'resolver-agent',
          Cookie: 'ttwid=ephemeral',
        },
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back immediately when resolver media has no FLV bytes', async () => {
    process.env.DOUYIN_RESOLVER_URL = 'http://douyin-resolver:7100';
    const badResolverUrl =
      'https://pull.example/bad.flv?auth_key=private-resolver-secret';
    let badMediaRequests = 0;
    const localLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('http://douyin-resolver:7100')) {
          return new Response(
            JSON.stringify({
              state: 'live',
              roomId: '742000000000',
              title: 'resolver title',
              stream: {
                url: badResolverUrl,
                effectiveQuality: 'high',
              },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        if (url === badResolverUrl) {
          badMediaRequests += 1;
          return new Response('', { status: 200 });
        }
        if (url.includes('/ttwid/union/register/')) {
          return new Response('', {
            status: 200,
            headers: {
              'set-cookie': 'ttwid=fallback-device; Path=/; HttpOnly',
            },
          });
        }
        if (url.startsWith('https://live.douyin.com/')) {
          return new Response(buildDouyinHtml(), { status: 200 });
        }
        if (url.startsWith('https://pull.example/live_')) {
          return flvResponse();
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

    const adapter = new DouyinAdapter(localLogger);
    const first = await adapter.getStream('douyin-web-rid', 'high');
    const second = await adapter.getStream('douyin-web-rid', 'high');

    expect(first.url).toBe('https://pull.example/live_uhd.flv');
    expect(second.url).toBe('https://pull.example/live_uhd.flv');
    expect(badMediaRequests).toBe(1);
    expect(
      (DouyinAdapter as any).resolverMediaCircuits.get('douyin-web-rid:high')
    ).toEqual(
      expect.objectContaining({
        failureCount: 1,
        retryAt: expect.any(Number),
      })
    );
    expect(JSON.stringify(localLogger.warn.mock.calls)).not.toContain(
      'private-resolver-secret'
    );
  });

  it('backs off resolver media validation exponentially after cooldowns', () => {
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const adapter = new DouyinAdapter(logger) as any;

    expect(adapter.openResolverMediaCircuit('room-a', 'high')).toBe(30_000);
    expect(adapter.isResolverMediaCircuitOpen('room-a', 'high')).toBe(true);

    jest.spyOn(Date, 'now').mockReturnValue(now + 30_001);
    expect(adapter.isResolverMediaCircuitOpen('room-a', 'high')).toBe(false);
    expect(adapter.openResolverMediaCircuit('room-a', 'high')).toBe(60_000);
    expect(
      (DouyinAdapter as any).resolverMediaCircuits.get('room-a:high')
    ).toEqual(expect.objectContaining({ failureCount: 2 }));
  });

  it('requires fallback confirmation when the resolver reports offline', async () => {
    process.env.DOUYIN_RESOLVER_URL = 'http://douyin-resolver:7100';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('http://douyin-resolver:7100')) {
          return new Response(
            JSON.stringify({
              state: 'offline',
              roomId: '742000000000',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        if (url.includes('/ttwid/union/register/')) {
          return new Response('', {
            status: 200,
            headers: {
              'set-cookie': 'ttwid=fallback-device; Path=/; HttpOnly',
            },
          });
        }
        if (url.startsWith('https://live.douyin.com/')) {
          return new Response(buildDouyinHtml(), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
    const localLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;
    const adapter = new DouyinAdapter(localLogger);

    await expect(adapter.getStreamerStatus('douyin-web-rid')).resolves.toEqual(
      expect.objectContaining({ isLive: true })
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(localLogger.warn).toHaveBeenCalledWith(
      'Douyin resolver reported offline but fallback detected a live stream',
      {
        streamerId: 'douyin-web-rid',
        webRid: 'douyin-web-rid',
      }
    );
  });

  it('does not silently accept offline when fallback verification is cooling down', async () => {
    process.env.DOUYIN_RESOLVER_URL = 'http://douyin-resolver:7100';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          state: 'offline',
          roomId: '742000000000',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    const adapter = new DouyinAdapter(logger) as any;
    adapter.openCircuit('room-info', 'douyin-web-rid');

    await expect(adapter.getStreamerStatus('douyin-web-rid')).rejects.toEqual(
      expect.objectContaining({ code: 'DOUYIN_BACKOFF' })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((DouyinAdapter as any).circuits.has('douyin-web-rid')).toBe(true);
  });

  it('briefly caches an offline result confirmed by both sources', async () => {
    process.env.DOUYIN_RESOLVER_URL = 'http://douyin-resolver:7100';
    const now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('http://douyin-resolver:7100')) {
          return new Response(
            JSON.stringify({
              state: 'offline',
              roomId: '742000000000',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        if (url.includes('/ttwid/union/register/')) {
          return new Response('', {
            status: 200,
            headers: {
              'set-cookie': 'ttwid=fallback-device; Path=/; HttpOnly',
            },
          });
        }
        if (url.startsWith('https://live.douyin.com/')) {
          return new Response(buildDouyinHtml(4), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
    const adapter = new DouyinAdapter(logger);

    await expect(adapter.getStreamerStatus('douyin-web-rid')).resolves.toEqual(
      expect.objectContaining({ isLive: false })
    );
    jest.spyOn(Date, 'now').mockReturnValue(now + 5_001);
    await expect(adapter.getStreamerStatus('douyin-web-rid')).resolves.toEqual(
      expect.objectContaining({ isLive: false })
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith('https://live.douyin.com/')
      )
    ).toHaveLength(1);
  });

  it('lets a live resolver result override a cached offline confirmation', async () => {
    process.env.DOUYIN_RESOLVER_URL = 'http://douyin-resolver:7100';
    (DouyinAdapter as any).offlineConfirmations.set('douyin-web-rid', {
      expiresAt: Date.now() + 30_000,
      snapshot: {
        webRid: 'douyin-web-rid',
        room: { id_str: '742000000000', status: 4 },
      },
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          state: 'live',
          roomId: '742000000000',
          title: 'resolver title',
          stream: {
            url: 'https://pull.example/resolver.flv',
            effectiveQuality: 'high',
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    const adapter = new DouyinAdapter(logger);

    await expect(adapter.getStreamerStatus('douyin-web-rid')).resolves.toEqual(
      expect.objectContaining({ isLive: true })
    );
    expect(
      (DouyinAdapter as any).offlineConfirmations.has('douyin-web-rid')
    ).toBe(false);
  });

  it('returns short backoff for a busy resolver without entering anti-bot fallback', async () => {
    process.env.DOUYIN_RESOLVER_URL = 'http://douyin-resolver:7100';
    const browserPageProvider = jest.fn();
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          state: 'unavailable',
          code: 'BUSY',
          message: 'retry later',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    const adapter = new DouyinAdapter(logger, {
      browserPageProvider,
    });

    await expect(adapter.getStreamerStatus('douyin-web-rid')).rejects.toEqual(
      expect.objectContaining({
        code: 'DOUYIN_BACKOFF',
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browserPageProvider).not.toHaveBeenCalled();
  });

  it('reuses one fallback guest identity for page parsing, validation, and FFmpeg', async () => {
    process.env.DOUYIN_RESOLVER_URL = 'http://douyin-resolver:7100';
    let pageCookie = '';
    let validationCookie = '';
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const headers = init?.headers as Record<string, string> | undefined;
          if (url.startsWith('http://douyin-resolver:7100')) {
            return new Response(
              JSON.stringify({
                state: 'unavailable',
                code: 'UPSTREAM_ERROR',
                message: 'temporary failure',
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }
          if (url.includes('/ttwid/union/register/')) {
            return new Response('', {
              status: 200,
              headers: {
                'set-cookie': 'ttwid=stable-guest; Path=/; HttpOnly',
              },
            });
          }
          if (url.startsWith('https://live.douyin.com/')) {
            pageCookie = headers?.Cookie || '';
            return new Response(buildDouyinHtml(), { status: 200 });
          }
          if (url.startsWith('https://pull.example/')) {
            validationCookie = headers?.Cookie || '';
            return flvResponse();
          }
          throw new Error(`Unexpected URL: ${url}`);
        }
      );

    const adapter = new DouyinAdapter(logger);
    const resolved = await adapter.getStream('douyin-web-rid', 'low');

    expect(pageCookie).toContain('ttwid=stable-guest');
    expect(validationCookie).toBe(pageCookie);
    expect(resolved.headers).toEqual(
      expect.objectContaining({
        Cookie: pageCookie,
      })
    );
  });

  it('redacts signed URL queries from validation errors', async () => {
    const signedUrl =
      'https://pull.example:bad/live.flv?auth_key=private-url-secret';
    const localLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(
        new TypeError(`Failed to parse URL from ${signedUrl}`)
      );

    const adapter = new DouyinAdapter(localLogger) as any;
    await expect(adapter.validateStreamUrl(signedUrl, {})).resolves.toBe(false);

    expect(localLogger.debug).toHaveBeenCalledWith(
      'Douyin stream URL validation failed',
      {
        url: 'https://pull.example:bad/live.flv',
        error: 'Failed to parse URL from https://pull.example:bad/live.flv',
      }
    );
    expect(JSON.stringify(localLogger.debug.mock.calls)).not.toContain(
      'private-url-secret'
    );
  });

  it('accepts an HLS manifest with a BOM and leading whitespace', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('\uFEFF  \n#EXTM3U\n#EXT-X-VERSION:3\n', { status: 200 })
      );
    const adapter = new DouyinAdapter(logger) as any;

    await expect(
      adapter.validateStreamUrl('https://pull.example/live.m3u8', {}, 'hls')
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pull.example/live.m3u8',
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('rejects a truncated FLV that ends after the container header', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(FLV_PREFIX.subarray(0, 13), {
        status: 200,
      })
    );
    const adapter = new DouyinAdapter(logger) as any;

    await expect(
      adapter.validateStreamUrl('https://pull.example/truncated.flv', {}, 'flv')
    ).resolves.toBe(false);
  });

  it('bounds media validation reads and cancels an endless response', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(body, { status: 200 }));
    const adapter = new DouyinAdapter(logger) as any;

    await expect(
      adapter.validateStreamUrl('https://pull.example/endless.m3u8', {}, 'hls')
    ).resolves.toBe(false);
    expect(cancelled).toBe(true);
  });

  it('times out while waiting for the first media byte', async () => {
    jest.useFakeTimers();
    try {
      jest
        .spyOn(global, 'fetch')
        .mockImplementation(
          async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                init?.signal?.addEventListener('abort', () => {
                  controller.error(new Error('media body aborted'));
                });
              },
            });
            return new Response(body, { status: 200 });
          }
        );
      const adapter = new DouyinAdapter(logger) as any;
      const request = adapter.validateStreamUrl(
        'https://pull.example/stalled.flv',
        {},
        'flv'
      );

      await jest.advanceTimersByTimeAsync(8_000);
      await expect(request).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects unknown resolver states instead of treating them as offline', () => {
    const adapter = new DouyinAdapter(logger) as any;

    expect(() =>
      adapter.parseResolverResponse({
        state: 'unexpected',
        roomId: '742000000000',
      })
    ).toThrow('Invalid Douyin resolver response');
    expect(() =>
      adapter.parseResolverResponse({
        state: 'live',
        stream: {
          url: 'https://pull.example/resolver.flv',
          effectiveQuality: 'ultra',
        },
      })
    ).toThrow('Invalid Douyin resolver response');
  });

  it('purges expired resolver snapshots containing ephemeral headers', async () => {
    process.env.DOUYIN_RESOLVER_URL = 'http://douyin-resolver:7100';
    (DouyinAdapter as any).resolverCache.set('expired-secret', {
      expiresAt: Date.now() - 1,
      snapshot: {
        webRid: 'old-room',
        room: { status: 2 },
        resolverStream: {
          url: 'https://pull.example/old.flv',
          headers: { Cookie: 'ttwid=expired-secret' },
        },
      },
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          state: 'offline',
          roomId: '742000000000',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const adapter = new DouyinAdapter(logger) as any;
    jest.spyOn(adapter, 'fetchFallbackRoomSnapshot').mockResolvedValue({
      webRid: 'douyin-web-rid',
      room: { id_str: '742000000000', status: 4 },
    });
    const status = await adapter.getStreamerStatus('douyin-web-rid');

    expect(status.isLive).toBe(false);
    expect((DouyinAdapter as any).resolverCache.has('expired-secret')).toBe(
      false
    );
  });

  it('bounds fallback HTTP requests with an abort timeout', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(global, 'fetch').mockImplementation(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('request aborted'));
            });
          })
      );

      const adapter = new DouyinAdapter(logger) as any;
      const request = adapter.fetchText('https://live.douyin.com/test');
      const rejection = expect(request).rejects.toThrow('request aborted');

      await jest.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the fallback timeout active while consuming the response body', async () => {
    jest.useFakeTimers();
    try {
      jest
        .spyOn(global, 'fetch')
        .mockImplementation(
          async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () => {
                  controller.error(new Error('body aborted'));
                });
              },
            });
            return new Response(body, { status: 200 });
          }
        );

      const adapter = new DouyinAdapter(logger) as any;
      const request = adapter.fetchText('https://live.douyin.com/test');
      const rejection = expect(request).rejects.toThrow('body aborted');

      await jest.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not cache a fallback identity without ttwid', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    const adapter = new DouyinAdapter(logger) as any;

    await expect(adapter.getGuestCookie('room-a')).resolves.toBe('');
    await expect(adapter.getGuestCookie('room-a')).resolves.toBe('');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((DouyinAdapter as any).guestCookieCache).toBeUndefined();
  });

  it('isolates room-info fallback circuit breakers by room', () => {
    const adapter = new DouyinAdapter(logger) as any;

    adapter.openCircuit('room-info', 'bad-room');

    expect(() => adapter.assertFallbackCircuitClosed('bad-room')).toThrow(
      'Douyin resolver is cooling down'
    );
    expect(() =>
      adapter.assertFallbackCircuitClosed('healthy-room')
    ).not.toThrow();

    adapter.openCircuit('captcha', 'bad-room');
    expect(() => adapter.assertFallbackCircuitClosed('healthy-room')).toThrow(
      'Douyin resolver is cooling down'
    );
  });
});
