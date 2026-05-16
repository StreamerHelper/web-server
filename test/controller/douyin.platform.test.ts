import { DouyinAdapter } from '../../src/platform/douyin';

function buildDouyinHtml() {
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
              status: 2,
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
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;

  afterEach(() => {
    jest.restoreAllMocks();
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
        return new Response('', { status: 200 });
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
});
