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

  it('keeps refreshed stream credentials in memory and persists only a sanitized URL', async () => {
    const updateMetadata = jest.fn().mockResolvedValue(undefined);
    const refreshedHeaders = { cookie: 'ttwid=ephemeral-secret' };
    const signedUrl =
      'https://pull.example/live.flv?auth_key=private-stream-url#fragment';
    const recording = new Recording({
      id: 'job-refresh',
      jobId: 'display-refresh',
      platform: 'douyin',
      streamerId: 'streamer-1',
      streamUrl: 'https://pull.example/old.flv',
      danmakuUrl: '',
      roomId: 'room-1',
      outputDir: '/tmp/job-refresh',
      refreshStream: jest.fn().mockResolvedValue({
        url: signedUrl,
        headers: refreshedHeaders,
        requestedQuality: 'high',
        effectiveQuality: 'high',
        qualityApplied: true,
      }),
      services: {
        jobService: { updateMetadata } as any,
        danmakuManager: {} as any,
        bullFramework: {} as any,
        app: {} as any,
      },
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      } as any,
    }) as any;

    await recording.refreshStreamUrl();

    expect(recording.streamUrl).toBe(signedUrl);
    expect(recording.streamHeaders).toBe(refreshedHeaders);
    expect(updateMetadata).toHaveBeenCalledWith(
      'job-refresh',
      expect.objectContaining({
        stream_url: 'https://pull.example/live.flv',
      })
    );
    expect(JSON.stringify(updateMetadata.mock.calls)).not.toContain(
      'private-stream-url'
    );
    expect(JSON.stringify(updateMetadata.mock.calls)).not.toContain(
      'ephemeral-secret'
    );
  });

  it('keeps natural-exit and heartbeat recovery single-flight', async () => {
    jest.useFakeTimers();
    try {
      const updateMetadata = jest.fn().mockResolvedValue(undefined);
      const checkLiveStatus = jest.fn(
        async () =>
          await new Promise<any>(resolve => {
            setTimeout(
              () =>
                resolve({
                  isLive: true,
                  roomId: 'room-1',
                  streamerId: 'streamer-1',
                  title: 'live',
                  viewerCount: 0,
                }),
              25_000
            );
          })
      );
      const refreshStream = jest.fn().mockResolvedValue({
        url: 'https://pull.example/refreshed.flv?auth_key=private',
        headers: { Cookie: 'ttwid=ephemeral' },
        qualityApplied: true,
      });
      const recording = new Recording({
        id: 'job-recovery-race',
        jobId: 'display-recovery-race',
        platform: 'douyin',
        streamerId: 'streamer-1',
        streamUrl: 'https://pull.example/original.flv',
        danmakuUrl: '',
        roomId: 'room-1',
        outputDir: '/tmp/job-recovery-race',
        refreshStream,
        checkLiveStatus,
        services: {
          jobService: {
            findById: jest.fn(
              async () =>
                await new Promise(resolve => {
                  setTimeout(() => resolve({ status: 'recording' }), 20_000);
                })
            ),
            updateMetadata,
          } as any,
          danmakuManager: {} as any,
          bullFramework: {} as any,
          app: {} as any,
        },
        logger: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          debug: jest.fn(),
        } as any,
        recordingConfig: {
          heartbeatInterval: 3_000,
          heartbeatTimeout: 10_000,
          maxRecordingTime: 60_000,
        },
      }) as any;

      recording.processListChanges = jest.fn().mockResolvedValue(undefined);
      recording.resolveEndReason = jest.fn();
      recording.startFFmpegProcess = jest.fn(async () => {
        recording.resetHeartbeatTimer();
      });
      recording.ffmpeg.stop = jest.fn().mockResolvedValue(undefined);
      recording.resetHeartbeatTimer();

      recording.handleFFmpegExit({
        code: 0,
        signal: null,
        isNatural: true,
      });
      await jest.advanceTimersByTimeAsync(10_000);

      expect(checkLiveStatus).toHaveBeenCalledTimes(1);
      expect(recording.ffmpeg.stop).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(15_000);
      await jest.advanceTimersByTimeAsync(5_000);

      expect(checkLiveStatus).toHaveBeenCalledTimes(1);
      expect(refreshStream).toHaveBeenCalledTimes(1);
      expect(recording.startFFmpegProcess).toHaveBeenCalledTimes(1);
      expect(recording.ffmpeg.stop).not.toHaveBeenCalled();
      expect(recording.ffmpegRestartTimer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels an in-flight natural-exit recovery when recording stops', async () => {
    jest.useFakeTimers();
    try {
      const jobService = {
        updateMetadata: jest.fn().mockResolvedValue(undefined),
        updateStatus: jest.fn().mockResolvedValue(undefined),
      };
      const checkLiveStatus = jest.fn(
        async () =>
          await new Promise<any>(resolve => {
            setTimeout(
              () =>
                resolve({
                  isLive: true,
                  roomId: 'room-1',
                  streamerId: 'streamer-1',
                  title: 'live',
                  viewerCount: 0,
                }),
              25_000
            );
          })
      );
      const refreshStream = jest.fn().mockResolvedValue({
        url: 'https://pull.example/refreshed.flv',
        qualityApplied: true,
      });
      const recording = new Recording({
        id: 'job-stop-recovery',
        jobId: 'display-stop-recovery',
        platform: 'douyin',
        streamerId: 'streamer-1',
        streamUrl: 'https://pull.example/original.flv',
        danmakuUrl: '',
        roomId: 'room-1',
        outputDir: '/tmp/job-stop-recovery',
        refreshStream,
        checkLiveStatus,
        services: {
          jobService: jobService as any,
          danmakuManager: {} as any,
          bullFramework: {} as any,
          app: {} as any,
        },
        logger: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          debug: jest.fn(),
        } as any,
      }) as any;

      recording.processListChanges = jest.fn().mockResolvedValue(undefined);
      recording.startFFmpegProcess = jest.fn().mockResolvedValue(undefined);
      recording.ffmpeg.stop = jest.fn().mockResolvedValue(undefined);
      recording.stopDanmaku = jest.fn().mockResolvedValue(undefined);
      recording.cleanup = jest.fn();
      recording.waitForUploadsToSettle = jest.fn().mockResolvedValue({
        expectedVideoSegments: 0,
        uploadedVideoSegments: 0,
        failedVideoSegments: 0,
        expectedDanmakuSegments: 0,
        uploadedDanmakuSegments: 0,
        failedDanmakuSegments: 0,
        settled: true,
        timedOut: false,
      });
      recording.scheduleCleanup = jest.fn().mockResolvedValue(undefined);

      recording.handleFFmpegExit({
        code: 0,
        signal: null,
        isNatural: true,
      });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(checkLiveStatus).toHaveBeenCalledTimes(1);

      await recording.stop('cancelled');
      await jest.advanceTimersByTimeAsync(20_000);

      expect(refreshStream).not.toHaveBeenCalled();
      expect(recording.startFFmpegProcess).not.toHaveBeenCalled();
      expect(recording.ffmpeg.stop).toHaveBeenCalledTimes(1);
      expect(recording.ffmpegRestartTimer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
