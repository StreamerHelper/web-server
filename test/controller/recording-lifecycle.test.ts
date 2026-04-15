import { Recording } from '../../src/service/recording';

jest.mock('chokidar', () => ({
  __esModule: true,
  default: {
    watch: jest.fn(() => ({
      on: jest.fn(),
      close: jest.fn(),
    })),
  },
}));

describe('Recording lifecycle', () => {
  it('marks natural ffmpeg exits as completed after flushing final segments', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    const recording = new Recording({
      id: 'job-natural-exit',
      jobId: 'display-natural-exit',
      platform: 'bilibili',
      streamerId: 'streamer-1',
      streamUrl: 'https://example.com/live.flv',
      danmakuUrl: 'wss://example.com/danmaku',
      roomId: 'room-1',
      outputDir: '/tmp/job-natural-exit',
      services: {
        jobService: {} as any,
        danmakuManager: {} as any,
        bullFramework: {} as any,
        app: {} as any,
      },
      logger: logger as any,
    }) as any;

    recording.processListChanges = jest.fn().mockResolvedValue(undefined);
    recording.resolveEndReason = jest.fn();

    recording.handleFFmpegExit({
      code: 0,
      signal: null,
      isNatural: true,
    });

    await new Promise(resolve => setImmediate(resolve));

    expect(recording.processListChanges).toHaveBeenCalledTimes(1);
    expect(recording.resolveEndReason).toHaveBeenCalledWith('completed');
  });
});
