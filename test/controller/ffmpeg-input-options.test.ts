import { FFmpegService } from '../../src/service/ffmpeg.service';

describe('FFmpeg input option selection', () => {
  it('pins segment filenames to UTC independently of the application timezone', () => {
    const service = new FFmpegService() as any;

    expect(service.buildSegmentProcessEnvironment()).toEqual(
      expect.objectContaining({ TZ: 'UTC' })
    );
  });

  it('adds anti-leech headers for bilibili FLV streams', () => {
    const service = new FFmpegService() as any;

    const headers = service.buildHttpHeaders(
      'https://d1--cn-gotcha07.bilivideo.com/live-bvc/test/live.flv?qn=250',
      'bilibili',
      '25248835'
    );
    const options = service.buildInputOptions(
      'https://d1--cn-gotcha07.bilivideo.com/live-bvc/test/live.flv?qn=250',
      headers
    );

    expect(headers).toContain('Referer: https://live.bilibili.com/25248835');
    expect(headers).toContain('Origin: https://live.bilibili.com');
    expect(headers.endsWith('\r\n')).toBe(true);
    expect(options).toContain('-reconnect_at_eof');
    expect(options).toContain('-reconnect_streamed');
    expect(options).toContain('-multiple_requests');
  });

  it('does not apply FLV reconnect strategy to HLS playlists', () => {
    const service = new FFmpegService() as any;

    const headers = service.buildHttpHeaders(
      'https://d1--cn-gotcha104.bilivideo.com/live-bvc/test/live.m3u8?qn=10000',
      'bilibili',
      '366'
    );
    const options = service.buildInputOptions(
      'https://d1--cn-gotcha104.bilivideo.com/live-bvc/test/live.m3u8?qn=10000',
      headers
    );

    expect(options).toEqual(['-headers', headers, '-rw_timeout', '15000000']);
    expect(options).not.toContain('-reconnect_at_eof');
    expect(options).not.toContain('-reconnect_streamed');
    expect(options).not.toContain('-multiple_requests');
  });

  it('adds anti-leech headers for douyin streams', () => {
    const service = new FFmpegService() as any;

    const headers = service.buildHttpHeaders(
      'https://pull-flv-l6.douyincdn.com/stage/live.flv',
      'douyin',
      '742000000000'
    );

    expect(headers).toContain('Referer: https://live.douyin.com/742000000000');
    expect(headers).toContain('Origin: https://live.douyin.com');
  });

  it('uses resolver headers verbatim in memory and rejects header injection', () => {
    const service = new FFmpegService() as any;

    const headers = service.buildHttpHeaders(
      'https://pull-flv-l6.douyincdn.com/stage/live.flv',
      'douyin',
      '742000000000',
      {
        'user-agent': 'resolver-agent',
        cookie: 'ttwid=ephemeral',
        referer: 'https://live.douyin.com/',
        'X-Unsafe': 'safe\r\nInjected: true',
        Host: 'attacker.example',
      }
    );

    expect(headers).toContain('User-Agent: resolver-agent');
    expect(headers).toContain('Cookie: ttwid=ephemeral');
    expect(headers).toContain('Referer: https://live.douyin.com/');
    expect(headers).not.toContain(
      'Referer: https://live.douyin.com/742000000000'
    );
    expect(headers).not.toContain('Injected');
    expect(headers).not.toContain('attacker.example');
  });

  it('redacts platform headers from failure diagnostics', () => {
    const service = new FFmpegService() as any;

    expect(
      service.redactSensitiveArgs([
        '-headers',
        'Cookie: sessionid=secret\r\n',
        '-i',
        'https://pull.example/live.flv?auth_key=private-url#fragment',
      ])
    ).toEqual([
      '-headers',
      '[REDACTED HTTP HEADERS]',
      '-i',
      'https://pull.example/live.flv',
    ]);
  });

  it('removes signed URL queries from buffered FFmpeg diagnostics', () => {
    const service = new FFmpegService() as any;
    service.logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    service.handleStderrOutput(
      'input https://pull.example/live.flv?auth_key=private-url failed'
    );

    expect(service.recentStderrLines).toEqual([
      'input https://pull.example/live.flv failed',
    ]);
    expect(JSON.stringify(service.logger.error.mock.calls)).not.toContain(
      'private-url'
    );
  });
});
