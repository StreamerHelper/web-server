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
      streamUrl: 'https://example.com/live.flv',
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
        ffmpegRestartAttempts: 2,
        videoSegments: 1,
        danmakuSegments: 1,
      })
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
});
