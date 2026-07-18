import { BilibiliSubmissionRecoveryService } from '../../src/service/bilibili-submission-recovery.service';

describe('BilibiliSubmissionRecoveryService', () => {
  const createService = () => {
    const service = new BilibiliSubmissionRecoveryService() as any;
    service.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    service.queue = {
      addJobToQueue: jest.fn(),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    service.bullFramework = {
      getQueue: jest.fn(() => service.queue),
    };
    service.submissionRepository = {
      findRecoverableSubmissions: jest.fn(),
    };
    return service;
  };

  it('requeues recoverable submissions on startup', async () => {
    const service = createService();
    service.submissionRepository.findRecoverableSubmissions.mockResolvedValue([
      { id: 'submission-1' },
      { id: 'submission-2' },
    ]);

    await expect(service.resumeRecoverableSubmissions()).resolves.toBe(2);

    expect(service.queue.addJobToQueue).toHaveBeenCalledTimes(2);
    expect(service.queue.addJobToQueue).toHaveBeenNthCalledWith(
      1,
      { submissionId: 'submission-1' },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      }
    );
    expect(service.queue.addJobToQueue).toHaveBeenNthCalledWith(
      2,
      { submissionId: 'submission-2' },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      }
    );
  });

  it('does not duplicate submissions already present in the queue', async () => {
    const service = createService();
    service.submissionRepository.findRecoverableSubmissions.mockResolvedValue([
      { id: 'submission-queued' },
      { id: 'submission-missing' },
    ]);
    service.queue.getJobs.mockResolvedValue([
      { data: { submissionId: 'submission-queued' } },
    ]);

    await expect(service.resumeRecoverableSubmissions()).resolves.toBe(1);

    expect(service.queue.addJobToQueue).toHaveBeenCalledTimes(1);
    expect(service.queue.addJobToQueue).toHaveBeenCalledWith(
      { submissionId: 'submission-missing' },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      }
    );
  });

  it('does not fail startup when the queue is unavailable', async () => {
    const service = createService();
    service.bullFramework.getQueue.mockReturnValue(undefined);

    await expect(service.resumeRecoverableSubmissions()).resolves.toBe(0);

    expect(
      service.submissionRepository.findRecoverableSubmissions
    ).not.toHaveBeenCalled();
    expect(service.logger.warn).toHaveBeenCalledWith(
      'Bilibili submission queue is unavailable during resume'
    );
  });
});
