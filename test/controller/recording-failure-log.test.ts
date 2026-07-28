import { JOB_STATUS } from '../../src/interface';
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

describe('Recording abnormal exit logging', () => {
  const createRecording = () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    const failureLogger = {
      error: jest.fn(),
    };

    const recording = new Recording({
      id: 'job-123',
      jobId: 'display-123',
      platform: 'bilibili',
      streamerId: 'streamer-1',
      streamUrl:
        'https://example.com/live.flv?auth_key=private-stream-url#fragment',
      danmakuUrl: 'wss://example.com/danmaku',
      roomId: 'room-1',
      outputDir: '/tmp/job-123',
      services: {
        jobService: {} as any,
        danmakuManager: {} as any,
        bullFramework: {} as any,
        app: {} as any,
      },
      logger: logger as any,
      ffmpegFailureLogger: failureLogger as any,
    });

    return { recording: recording as any, failureLogger };
  };

  it('writes recorder abnormal exits to the dedicated failure logger', () => {
    const { recording, failureLogger } = createRecording();

    recording.failureReason = 'Timed out waiting for uploads';
    recording.recordingFailed = true;
    recording.status = 'failed';
    recording.ffmpegRestartAttempts = 2;
    recording.lastFFmpegOutputTime = 1713020000000;
    recording.segmentCount = 12;
    recording.videoSegments = ['raw/job-123/video/a.mkv'];
    recording.danmakuSegments = ['danmaku/job-123/a.jsonl'];

    recording.logAbnormalRecorderExit('heartbeat_timeout', JOB_STATUS.FAILED, {
      expectedVideoSegments: 1,
      uploadedVideoSegments: 0,
      failedVideoSegments: 1,
      expectedDanmakuSegments: 1,
      uploadedDanmakuSegments: 1,
      failedDanmakuSegments: 0,
      settled: true,
      timedOut: false,
    });

    expect(failureLogger.error).toHaveBeenCalledWith(
      'Recorder abnormal exit',
      expect.objectContaining({
        id: 'job-123',
        jobId: 'display-123',
        reason: 'heartbeat_timeout',
        finalStatus: JOB_STATUS.FAILED,
        failureReason: 'Timed out waiting for uploads',
        streamUrl: 'https://example.com/live.flv',
        ffmpegRestartAttempts: 2,
        videoSegments: 1,
        danmakuSegments: 1,
      })
    );
    expect(JSON.stringify(failureLogger.error.mock.calls[0])).not.toContain(
      'private-stream-url'
    );
  });

  it('does not consider completed exits abnormal', () => {
    const { recording } = createRecording();

    expect(
      recording.shouldLogAbnormalRecorderExit('completed', JOB_STATUS.COMPLETED, {
        expectedVideoSegments: 1,
        uploadedVideoSegments: 1,
        failedVideoSegments: 0,
        expectedDanmakuSegments: 0,
        uploadedDanmakuSegments: 0,
        failedDanmakuSegments: 0,
        settled: true,
        timedOut: false,
      })
    ).toBe(false);
  });

  it('marks heartbeat timeouts as failed recorder exits', () => {
    const { recording } = createRecording();

    const finalStatus = recording.getFinalStatus('heartbeat_timeout', {
      expectedVideoSegments: 0,
      uploadedVideoSegments: 0,
      failedVideoSegments: 0,
      expectedDanmakuSegments: 0,
      uploadedDanmakuSegments: 0,
      failedDanmakuSegments: 0,
      settled: true,
      timedOut: false,
    });

    expect(finalStatus).toBe(JOB_STATUS.FAILED);
    expect(recording.failureReason).toBe(
      'FFmpeg heartbeat timed out while recording'
    );
  });

  it('marks stream refresh recovery exhaustion as failed recorder exits', () => {
    const { recording } = createRecording();

    const finalStatus = recording.getFinalStatus('stream_refresh_failed', {
      expectedVideoSegments: 0,
      uploadedVideoSegments: 0,
      failedVideoSegments: 0,
      expectedDanmakuSegments: 0,
      uploadedDanmakuSegments: 0,
      failedDanmakuSegments: 0,
      settled: true,
      timedOut: false,
    });

    expect(finalStatus).toBe(JOB_STATUS.FAILED);
    expect(recording.failureReason).toBe(
      'Stream URL refresh failed and live status could not be confirmed'
    );
    expect(
      recording.shouldLogAbnormalRecorderExit(
        'stream_refresh_failed',
        JOB_STATUS.FAILED,
        {
          expectedVideoSegments: 0,
          uploadedVideoSegments: 0,
          failedVideoSegments: 0,
          expectedDanmakuSegments: 0,
          uploadedDanmakuSegments: 0,
          failedDanmakuSegments: 0,
          settled: true,
          timedOut: false,
        }
      )
    ).toBe(true);
  });

  it('does not complete jobs when stream refresh recovery is exhausted', () => {
    const { recording } = createRecording();

    recording.ffmpegRestartAttempts = (Recording as any)
      .MAX_FFMPEG_RESTART_ATTEMPTS;
    recording.persistStreamRecoveryState = jest.fn();
    recording.resolveEndReason = jest.fn();

    recording.scheduleFFmpegRestart(
      { code: null, signal: null, isNatural: false },
      'stream_refresh_failed'
    );

    expect(recording.recordingFailed).toBe(true);
    expect(recording.failureReason).toContain('Stream URL refresh failed');
    expect(recording.persistStreamRecoveryState).toHaveBeenCalledWith(
      expect.objectContaining({
        streamRecoveryInProgress: false,
        streamRecoveryReason: 'stream_refresh_failed',
      })
    );
    expect(recording.resolveEndReason).toHaveBeenCalledWith(
      'stream_refresh_failed'
    );
  });
});
