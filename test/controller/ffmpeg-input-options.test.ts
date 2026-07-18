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
});
