import { NoticeLoggerTransport } from '../../src/service/notice/notice-logger.transport';
import { NoticeService } from '../../src/service/notice/notice.service';
import { MidwayLogger } from '@midwayjs/logger';
import {
  NormalizedNotice,
  NoticeChannel,
  NoticeConfig,
} from '../../src/service/notice/notice.types';
import {
  resolveServerChanEndpoint,
  ServerChanNoticeChannel,
} from '../../src/service/notice/server-chan.notice-channel';

const createConfig = (): NoticeConfig => ({
  enabled: true,
  appName: 'StreamerHelper',
  maxContentLength: 4000,
  logger: {
    enabled: true,
    level: 'error',
    fatigueSeconds: 300,
  },
  channels: {
    serverChan: {
      enabled: false,
      sendKey: '',
      endpoint: '',
      timeoutMs: 10000,
    },
  },
});

const createNoticeService = () => {
  const service = new NoticeService() as any;
  service.config = createConfig();
  service.internalLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return service as NoticeService;
};

describe('NoticeService', () => {
  it('fans out notices and isolates channel failures', async () => {
    const service = createNoticeService();
    const successfulChannel: NoticeChannel = {
      name: 'success',
      send: jest.fn().mockResolvedValue(undefined),
    };
    const failingChannel: NoticeChannel = {
      name: 'failure',
      send: jest.fn().mockRejectedValue(new Error('network unavailable')),
    };
    service.registerChannel(successfulChannel);
    service.registerChannel(failingChannel);

    const result = await service.send({
      title: 'Recording failed',
      content: 'FFmpeg exited unexpectedly',
      level: 'error',
    });

    expect(result.delivered).toEqual(['success']);
    expect(result.failed).toEqual([
      { channel: 'failure', error: 'network unavailable' },
    ]);
  });

  it('suppresses duplicate notices during the fatigue window', async () => {
    const service = createNoticeService();
    const channel: NoticeChannel = {
      name: 'test',
      send: jest.fn().mockResolvedValue(undefined),
    };
    service.registerChannel(channel);
    const notice = {
      title: 'Repeated error',
      content: 'same error',
      dedupeKey: 'same-error',
      fatigueSeconds: 300,
    };

    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const first = await service.send(notice);
    const suppressed = await service.send(notice);
    now.mockReturnValue(1_300_001);
    const afterFatigue = await service.send(notice);

    expect(first.suppressed).toBe(false);
    expect(suppressed.suppressed).toBe(true);
    expect(afterFatigue.suppressed).toBe(false);
    expect(channel.send).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('redacts secrets captured from structured logger arguments', async () => {
    const service = createNoticeService();
    const send = jest.fn().mockResolvedValue(undefined);
    service.registerChannel({ name: 'test', send });

    service.captureLoggerEvent({
      level: 'error',
      meta: {},
      args: [
        'Provider request failed token=private-token',
        {
          cookie: 'private-cookie',
          nested: { apiKey: 'private-key', status: 401 },
        },
      ],
    });
    await new Promise(resolve => setImmediate(resolve));

    const sentNotice = send.mock.calls[0][0] as NormalizedNotice;
    expect(sentNotice.content).toContain('[REDACTED]');
    expect(sentNotice.content).toContain('status: 401');
    expect(sentNotice.content).not.toContain('private-cookie');
    expect(sentNotice.content).not.toContain('private-key');
    expect(sentNotice.content).not.toContain('private-token');
  });

  it('attaches to the Midway app logger without changing call sites', async () => {
    const service = createNoticeService() as any;
    const send = jest.fn().mockResolvedValue(undefined);
    const appLogger = new MidwayLogger({ level: 'info' });
    service.appLogger = appLogger;
    service.registerChannel({ name: 'test', send });

    service.start();
    appLogger.warn('warning is below the configured notice level');
    appLogger.error('recording failed', { jobId: 'job-1' });
    await new Promise(resolve => setImmediate(resolve));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        title: '[ERROR] StreamerHelper',
        source: 'appLogger',
      })
    );
    await service.stop();
  });
});

describe('NoticeLoggerTransport', () => {
  it('forwards only logs allowed by the configured level', () => {
    const handler = jest.fn();
    const transport = new NoticeLoggerTransport({ level: 'warn' }, handler);
    transport.setLoggerOptions({ level: 'debug' });

    transport.log('info', {}, 'normal message');
    transport.log('warn', {}, 'warning message');
    transport.log('error', {}, 'error message');

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map(call => call[0].level)).toEqual([
      'warn',
      'error',
    ]);
  });
});

describe('ServerChanNoticeChannel', () => {
  it('uses the documented Turbo API and form fields', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue('{"code":0,"message":"success"}'),
    });
    const channel = new ServerChanNoticeChannel(
      { sendKey: 'SCT_test_key' },
      fetcher as any
    );

    await channel.send({
      title: 'Test notice',
      content: 'Test content',
      level: 'info',
      timestamp: new Date('2026-07-24T12:00:00.000Z'),
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://sctapi.ftqq.com/SCT_test_key.send',
      expect.objectContaining({ method: 'POST' })
    );
    const body = fetcher.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('title')).toBe('Test notice');
    expect(body.get('desp')).toContain('Test content');
  });

  it('derives the ServerChan 3 endpoint from an sctp SendKey', () => {
    expect(resolveServerChanEndpoint('sctp123t_private')).toBe(
      'https://123.push.ft07.com/send/sctp123t_private.send'
    );
  });
});
