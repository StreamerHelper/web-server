import { BilibiliSeasonService } from '../../src/service/bilibili-season.service';

describe('BilibiliSeasonService', () => {
  const createService = () => {
    const service = new BilibiliSeasonService() as any;
    service.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    service.credentialRepository = {
      findValid: jest.fn().mockResolvedValue({
        expiresAt: new Date(Date.now() + 3600_000),
        cookies: {
          SESSDATA: 'sess',
          bili_jct: 'csrf-token',
          Dedeuserid: '123',
        },
      }),
    };
    service.bilibiliUploadService = {
      resolveCoverForCreative: jest
        .fn()
        .mockResolvedValue('//archive.biliimg.com/cover.jpg'),
    };
    return service;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists seasons and their sections from the creative center API', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            total: 1,
            seasons: [
              {
                season: {
                  id: 1001,
                  title: '主播A直播录像',
                  desc: '直播合集',
                  cover: '//archive.biliimg.com/cover.jpg',
                  ep_num: 3,
                },
                sections: {
                  sections: [
                    {
                      id: 2002,
                      seasonId: 1001,
                      title: '正片',
                      epCount: 3,
                    },
                  ],
                },
              },
            ],
          },
        }),
        { status: 200 }
      )
    );

    const service = createService();
    const result = await service.listSeasons();

    expect(result).toEqual({
      total: 1,
      seasons: [
        {
          id: 1001,
          title: '主播A直播录像',
          desc: '直播合集',
          cover: '//archive.biliimg.com/cover.jpg',
          state: undefined,
          epCount: 3,
          sections: [
            {
              id: 2002,
              seasonId: 1001,
              title: '正片',
              order: undefined,
              epCount: 3,
            },
          ],
        },
      ],
    });
  });

  it('adds a timestamp when force refreshing the season list', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            total: 0,
            seasons: [],
          },
        }),
        { status: 200 }
      )
    );

    const service = createService();
    await service.listSeasons({ forceRefresh: true });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('ts')).toBeTruthy();
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        }),
      })
    );
  });

  it('adds a submitted archive to a season section with aid, cid and title', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname === '/x2/creative/web/season/section') {
            const hasAdded = fetchMock.mock.calls.length > 3;
            return new Response(
              JSON.stringify({
                code: 0,
                data: {
                  episodes: hasAdded
                    ? [
                        {
                          id: 3003,
                          aid: 123456,
                          cid: 654321,
                          title: '投稿标题',
                        },
                      ]
                    : [],
                },
              }),
              { status: 200 }
            );
          }
          if (url.pathname === '/x/web-interface/view') {
            return new Response(
              JSON.stringify({
                code: 0,
                data: {
                  title: '接口标题',
                  pages: [{ cid: 654321 }],
                },
              }),
              { status: 200 }
            );
          }
          if (url.pathname === '/x2/creative/web/season/section/episodes/add') {
            const body = JSON.parse(String(init?.body || '{}'));
            expect(url.searchParams.get('csrf')).toBe('csrf-token');
            expect(body).toEqual({
              sectionId: 2002,
              episodes: [
                {
                  aid: 123456,
                  cid: 654321,
                  title: '投稿标题',
                  charging_pay: 0,
                },
              ],
            });
            return new Response(JSON.stringify({ code: 0 }), { status: 200 });
          }
          return new Response(JSON.stringify({ code: -404 }), { status: 404 });
        }
      );

    const service = createService();
    const result = await service.addVideoToSeason({
      aid: 123456,
      sectionId: 2002,
      title: '投稿标题',
    });

    expect(result).toEqual({
      added: true,
      alreadyExists: false,
      episodeId: 3003,
      aid: 123456,
      cid: 654321,
      title: '投稿标题',
      sectionId: 2002,
    });
  });

  it('creates a season and returns the created season with its default section', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname === '/x2/creative/web/season/add') {
            expect(init?.method).toBe('POST');
            const body = new URLSearchParams(String(init?.body || ''));
            expect(body.get('title')).toBe('主播A直播录像');
            expect(body.get('desc')).toBe('自动归档');
            expect(body.get('cover')).toBe('//archive.biliimg.com/cover.jpg');
            expect(body.get('season_price')).toBe('0');
            expect(body.get('csrf')).toBe('csrf-token');
            return new Response(JSON.stringify({ code: 0, data: 1001 }), {
              status: 200,
            });
          }
          if (url.pathname === '/x2/creative/web/seasons') {
            return new Response(
              JSON.stringify({
                code: 0,
                data: {
                  total: 1,
                  seasons: [
                    {
                      season: {
                        id: 1001,
                        title: '主播A直播录像',
                        desc: '自动归档',
                        cover: '//archive.biliimg.com/cover.jpg',
                      },
                      sections: {
                        sections: [
                          {
                            id: 2002,
                            seasonId: 1001,
                            title: '正片',
                          },
                        ],
                      },
                    },
                  ],
                },
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ code: -404 }), { status: 404 });
        }
      );

    const service = createService();
    const season = await service.createSeason({
      title: '主播A直播录像',
      desc: '自动归档',
      cover: 'data:image/png;base64,abc',
    });

    expect(
      service.bilibiliUploadService.resolveCoverForCreative
    ).toHaveBeenCalledWith('data:image/png;base64,abc');
    expect(season).toEqual(
      expect.objectContaining({
        id: 1001,
        title: '主播A直播录像',
        desc: '自动归档',
        sections: [
          expect.objectContaining({
            id: 2002,
            seasonId: 1001,
            title: '正片',
          }),
        ],
      })
    );
  });
});
