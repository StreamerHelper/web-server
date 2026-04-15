jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

const mockRecording = {
  id: 'job-1',
  platform: 'bilibili',
  streamerId: 'streamer-1',
  onceEnd: jest.fn(),
  start: jest.fn(),
  waitUntilStarted: jest.fn(),
  getInfo: jest.fn(),
};

const recordingConstructor = jest.fn(() => mockRecording);

jest.mock('../../src/service/recording', () => ({
  Recording: recordingConstructor,
}));

import { RecorderManager } from '../../src/service/recorder.manager';

describe('RecorderManager startup handling', () => {
  const createManager = () => {
    const manager = new RecorderManager() as any;
    manager.app = {};
    manager.jobService = {};
    manager.danmakuManager = {};
    manager.streamerService = {
      findByStreamerId: jest.fn(),
    };
    manager.submissionService = {
      createSubmission: jest.fn(),
    };
    manager.platformService = {
      resolveStream: jest.fn(),
    };
    manager.bullFramework = {
      getQueue: jest.fn(),
    };
    manager.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    manager.ffmpegExitLogger = {
      error: jest.fn(),
    };
    manager.recorderConfig = {
      heartbeatInterval: 3,
      heartbeatTimeout: 10,
      maxRecordingTime: 3600,
    };
    return manager;
  };

  beforeEach(() => {
    recordingConstructor.mockClear();
    mockRecording.onceEnd.mockClear();
    mockRecording.start.mockReset();
    mockRecording.start.mockResolvedValue(undefined);
    mockRecording.waitUntilStarted.mockReset();
    mockRecording.waitUntilStarted.mockResolvedValue(undefined);
    mockRecording.getInfo.mockReset();
  });

  it('waits for the recording to report startup success before returning', async () => {
    const manager = createManager();

    let resolveStarted!: () => void;
    mockRecording.waitUntilStarted.mockReturnValue(
      new Promise<void>(resolve => {
        resolveStarted = resolve;
      })
    );

    const startPromise = manager.startRecording('bilibili', 'streamer-1', {
      id: 'job-1',
      jobId: 'display-1',
      platform: 'bilibili',
      streamerId: 'streamer-1',
      streamUrl: 'https://example.com/live.flv',
      danmakuUrl: 'wss://example.com/danmaku',
      roomId: 'room-1',
      outputDir: '/tmp/job-1',
    });

    expect(mockRecording.start).toHaveBeenCalledTimes(1);

    let settled = false;
    startPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveStarted();

    await expect(startPromise).resolves.toBe(mockRecording);
  });

  it('cleans up the in-memory recording when startup fails', async () => {
    const manager = createManager();
    mockRecording.waitUntilStarted.mockRejectedValue(new Error('startup failed'));

    await expect(
      manager.startRecording('bilibili', 'streamer-1', {
        id: 'job-1',
        jobId: 'display-1',
        platform: 'bilibili',
        streamerId: 'streamer-1',
        streamUrl: 'https://example.com/live.flv',
        danmakuUrl: 'wss://example.com/danmaku',
        roomId: 'room-1',
        outputDir: '/tmp/job-1',
      })
    ).rejects.toThrow('startup failed');

    expect(manager.isRecording('bilibili', 'streamer-1')).toBe(false);
  });
});
