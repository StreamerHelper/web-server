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
import { getClassMetadata } from '@midwayjs/core';

describe('PollerProcessor scheduling', () => {
  it('does not retain timestamp-based poller jobs', () => {
    const metadata = getClassMetadata('bullmq:processor', PollerProcessor);

    expect(metadata.jobOptions).toEqual(
      expect.objectContaining({
        removeOnComplete: true,
        removeOnFail: true,
      })
    );
  });

  it('recovers interrupted jobs before checking streamers', async () => {
    const processor = new PollerProcessor() as any;
    processor.pollerConfig = { concurrency: 1 };
    processor.jobService = {
      recoverInterruptedJobsOnStartup: jest.fn().mockResolvedValue(1),
    };
    processor.streamerService = {
      findActive: jest.fn().mockResolvedValue([]),
    };
    processor.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    await expect(processor.execute()).resolves.toEqual({
      status: 'completed',
      checked: 0,
    });
    expect(
      processor.jobService.recoverInterruptedJobsOnStartup.mock.invocationCallOrder[0]
    ).toBeLessThan(
      processor.streamerService.findActive.mock.invocationCallOrder[0]
    );
  });
});

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
