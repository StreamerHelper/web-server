jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { StorageDeleteProcessor } from '../../src/processor/storage-delete.processor';

function buildJob(overrides: Record<string, any> = {}) {
  return {
    id: 'job-db-id',
    jobId: 'job-public-id',
    streamerId: 'streamer-1',
    platform: 'bilibili',
    status: 'completed',
    endTime: new Date('2026-05-18T11:50:00.000Z'),
    createdAt: new Date('2026-05-18T11:00:00.000Z'),
    updatedAt: new Date('2026-05-18T11:55:00.000Z'),
    metadata: {
      autoDelete: {
        enabled: true,
        delayMinutes: 1,
      },
      storageDeleteScheduledAt: '2026-05-18T11:51:00.000Z',
      storageDeleteDelayMinutes: 1,
    },
    ...overrides,
  };
}

function createProcessor() {
  const queue = {
    addJobToQueue: jest.fn().mockResolvedValue(undefined),
  };
  const processor = new StorageDeleteProcessor() as any;

  processor.jobService = {
    findById: jest.fn(),
    deleteJobStorage: jest.fn().mockResolvedValue({ deletedKeys: ['a', 'b'] }),
    updateMetadata: jest.fn().mockResolvedValue(undefined),
  };
  processor.streamerService = {
    findByStreamerId: jest.fn(),
  };
  processor.submissionRepository = {
    findByJobId: jest.fn().mockResolvedValue([]),
  };
  processor.uploadService = {
    getArchiveInfo: jest.fn().mockResolvedValue(null),
  };
  processor.bullFramework = {
    getQueue: jest.fn().mockReturnValue(queue),
  };
  processor.logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  return { processor, queue };
}

describe('StorageDeleteProcessor current streamer settings', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('skips scheduled deletion when the streamer disables auto delete', async () => {
    const { processor } = createProcessor();
    const job = buildJob();

    processor.jobService.findById.mockResolvedValue(job);
    processor.streamerService.findByStreamerId.mockResolvedValue({
      streamerId: 'streamer-1',
      platform: 'bilibili',
      recordSettings: {
        autoDelete: {
          enabled: false,
          delayMinutes: 1,
        },
      },
    });

    const result = await processor.execute({
      id: 'job-db-id',
      reason: 'scheduled',
    });

    expect(result).toEqual({ status: 'skipped', id: 'job-db-id' });
    expect(processor.jobService.deleteJobStorage).not.toHaveBeenCalled();
    expect(processor.submissionRepository.findByJobId).not.toHaveBeenCalled();
    expect(processor.jobService.updateMetadata).toHaveBeenCalledWith(
      'job-db-id',
      expect.objectContaining({
        storageDeleteSkipReason: 'auto_delete_disabled',
      })
    );
  });

  it('defers scheduled deletion when the streamer extends the delay', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-18T12:00:00.000Z'));

    const { processor, queue } = createProcessor();
    const job = buildJob();

    processor.jobService.findById.mockResolvedValue(job);
    processor.streamerService.findByStreamerId.mockResolvedValue({
      streamerId: 'streamer-1',
      platform: 'bilibili',
      recordSettings: {
        autoDelete: {
          enabled: true,
          delayMinutes: 60,
        },
      },
    });

    const result = await processor.execute({
      id: 'job-db-id',
      reason: 'scheduled',
    });

    expect(result).toEqual({ status: 'deferred', id: 'job-db-id' });
    expect(queue.addJobToQueue).toHaveBeenCalledWith(
      { id: 'job-db-id', reason: 'scheduled' },
      { delay: 50 * 60 * 1000 }
    );
    expect(processor.jobService.deleteJobStorage).not.toHaveBeenCalled();
    expect(processor.jobService.updateMetadata).toHaveBeenCalledWith(
      'job-db-id',
      expect.objectContaining({
        storageDeleteScheduledAt: '2026-05-18T12:50:00.000Z',
        storageDeleteDelayMinutes: 60,
      })
    );
  });

  it('defers scheduled deletion when a submission has failed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-18T12:00:00.000Z'));

    const { processor, queue } = createProcessor();
    const job = buildJob();

    processor.jobService.findById.mockResolvedValue(job);
    processor.streamerService.findByStreamerId.mockResolvedValue({
      streamerId: 'streamer-1',
      platform: 'bilibili',
      recordSettings: {
        autoDelete: {
          enabled: true,
          delayMinutes: 1,
        },
      },
    });
    processor.submissionRepository.findByJobId.mockResolvedValue([
      {
        id: 'submission-failed',
        status: 'failed',
        totalParts: 3,
        completedParts: 0,
        lastError: 'File size is greater than 2 GiB',
      },
    ]);

    const result = await processor.execute({
      id: 'job-db-id',
      reason: 'scheduled',
    });

    expect(result).toEqual({ status: 'deferred', id: 'job-db-id' });
    expect(queue.addJobToQueue).toHaveBeenCalledWith(
      { id: 'job-db-id', reason: 'scheduled' },
      { delay: 15 * 60 * 1000 }
    );
    expect(processor.jobService.deleteJobStorage).not.toHaveBeenCalled();
    expect(processor.jobService.updateMetadata).toHaveBeenCalledWith(
      'job-db-id',
      expect.objectContaining({
        storageDeleteDeferReason: 'submission_failed',
        storageDeleteBlockingSubmissions: [
          expect.objectContaining({
            id: 'submission-failed',
            status: 'failed',
          }),
        ],
      })
    );
  });

  it('defers scheduled deletion when auto upload is enabled but no submission exists yet', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-18T12:00:00.000Z'));

    const { processor, queue } = createProcessor();
    const job = buildJob();

    processor.jobService.findById.mockResolvedValue(job);
    processor.streamerService.findByStreamerId.mockResolvedValue({
      streamerId: 'streamer-1',
      platform: 'bilibili',
      recordSettings: {
        autoDelete: {
          enabled: true,
          delayMinutes: 1,
        },
      },
      uploadSettings: {
        autoUpload: true,
      },
    });
    processor.submissionRepository.findByJobId.mockResolvedValue([]);

    const result = await processor.execute({
      id: 'job-db-id',
      reason: 'scheduled',
    });

    expect(result).toEqual({ status: 'deferred', id: 'job-db-id' });
    expect(queue.addJobToQueue).toHaveBeenCalledWith(
      { id: 'job-db-id', reason: 'scheduled' },
      { delay: 15 * 60 * 1000 }
    );
    expect(processor.jobService.deleteJobStorage).not.toHaveBeenCalled();
    expect(processor.jobService.updateMetadata).toHaveBeenCalledWith(
      'job-db-id',
      expect.objectContaining({
        storageDeleteDeferReason: 'submission_missing',
      })
    );
  });

  it('deletes scheduled storage when current streamer settings still allow it', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-18T12:00:00.000Z'));

    const { processor } = createProcessor();
    const job = buildJob();

    processor.jobService.findById.mockResolvedValue(job);
    processor.streamerService.findByStreamerId.mockResolvedValue({
      streamerId: 'streamer-1',
      platform: 'bilibili',
      recordSettings: {
        autoDelete: {
          enabled: true,
          delayMinutes: 1,
        },
      },
      uploadSettings: { autoUpload: false },
    });

    const result = await processor.execute({
      id: 'job-db-id',
      reason: 'scheduled',
    });

    expect(result).toEqual({
      status: 'completed',
      id: 'job-db-id',
      deletedKeys: 2,
    });
    expect(processor.jobService.deleteJobStorage).toHaveBeenCalledWith(
      'job-db-id',
      'scheduled'
    );
  });

  it.each(['missing-tail', 'unfinished-part', 'bad-counters', 'recording'])(
    'preserves source files when submission completeness fails: %s',
    async failure => {
      const { processor } = createProcessor();
      const keys = ['raw/job/video/a.mkv', 'raw/job/video/b.mkv'];
      const job = buildJob({
        status: failure === 'recording' ? 'recording' : 'completed',
        metadata: { uploadedSegments: keys },
      });
      processor.jobService.findById.mockResolvedValue(job);
      processor.streamerService.findByStreamerId.mockResolvedValue({
        platform: 'bilibili',
        recordSettings: { autoDelete: { enabled: true, delayMinutes: 1 } },
        uploadSettings: { autoUpload: true },
      });
      processor.submissionRepository.findByJobId.mockResolvedValue([
        {
          id: 'submission',
          status: 'completed',
          bvid: 'BV1',
          avid: 1,
          totalParts: 1,
          completedParts: failure === 'bad-counters' ? 0 : 1,
          parts: [
            {
              index: 1,
              status: failure === 'unfinished-part' ? 'pending' : 'completed',
              filename: 'uploaded',
              cid: 1,
              s3Keys: failure === 'missing-tail' ? keys.slice(0, 1) : keys,
            },
          ],
        },
      ]);
      const result = await processor.execute({
        id: job.id,
        reason: 'scheduled',
      });
      expect(result.status).toBe('deferred');
      expect(processor.jobService.deleteJobStorage).not.toHaveBeenCalled();
    }
  );

  it('deletes only after completed parts cover all uploaded source segments', async () => {
    const { processor } = createProcessor();
    const keys = ['raw/job/video/a.mkv', 'raw/job/video/b.mkv'];
    const job = buildJob({ metadata: { uploadedSegments: keys } });
    processor.jobService.findById.mockResolvedValue(job);
    processor.streamerService.findByStreamerId.mockResolvedValue({
      platform: 'bilibili',
      recordSettings: { autoDelete: { enabled: true, delayMinutes: 1 } },
      uploadSettings: { autoUpload: true },
    });
    processor.submissionRepository.findByJobId.mockResolvedValue([
      {
        status: 'completed',
        bvid: 'BV1',
        avid: 1,
        totalParts: 1,
        completedParts: 1,
        parts: [
          { status: 'completed', filename: 'uploaded', cid: 1, s3Keys: keys },
        ],
      },
    ]);
    await processor.execute({ id: job.id, reason: 'scheduled' });
    expect(processor.jobService.deleteJobStorage).toHaveBeenCalledWith(
      job.id,
      'scheduled'
    );
  });
});
