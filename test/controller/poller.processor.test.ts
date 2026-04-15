jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

jest.mock('chokidar', () => ({
  __esModule: true,
  default: {
    watch: jest.fn(() => ({
      on: jest.fn(),
      close: jest.fn(),
    })),
  },
}));

import { PollerProcessor } from '../../src/processor/poller.processor';

describe('PollerProcessor heartbeat timeout selection', () => {
  it('uses recorder heartbeat timeout when checking active jobs', async () => {
    const processor = new PollerProcessor() as any;
    processor.recorderConfig = {
      heartbeatInterval: 3,
      heartbeatTimeout: 12,
      maxRecordingTime: 3600,
    };
    processor.streamerService = {
      updateLastCheckTime: jest.fn().mockResolvedValue(undefined),
    };
    processor.jobService = {
      findActiveJobForStreamer: jest.fn().mockResolvedValue(null),
    };
    processor.platformService = {
      checkLiveStatus: jest.fn().mockResolvedValue({ isLive: false }),
    };
    processor.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    await processor.checkStreamer({
      id: 'streamer-row-1',
      streamerId: 'streamer-1',
      platform: 'bilibili',
    });

    expect(processor.jobService.findActiveJobForStreamer).toHaveBeenCalledWith(
      'streamer-1',
      'bilibili',
      12000
    );
  });
});
