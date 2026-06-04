jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { TranscriptSchedulerService } from '../../src/service/transcript-scheduler.service';

describe('TranscriptSchedulerService', () => {
  const createService = () => {
    const addJobToQueue = jest.fn().mockResolvedValue(undefined);
    const service = new TranscriptSchedulerService() as any;
    service.asrConfig = {
      enabled: true,
      transcribeRecordings: true,
    };
    service.asrService = {
      isAvailable: jest.fn().mockReturnValue(true),
    };
    service.bullFramework = {
      getQueue: jest.fn().mockReturnValue({
        addJobToQueue,
      }),
    };
    service.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    return { service, addJobToQueue };
  };

  it('queues transcript jobs with local video paths for live segments', async () => {
    const { service, addJobToQueue } = createService();

    await expect(
      service.scheduleForVideoSegment({
        id: 'job-db-id',
        videoS3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
        localVideoPath: '/tmp/job/video/segment_20260605_010203.mkv',
        startTimeOffsetMs: 30000,
      })
    ).resolves.toBe(true);

    expect(service.bullFramework.getQueue).toHaveBeenCalledWith('transcript');
    expect(addJobToQueue).toHaveBeenCalledWith(
      {
        id: 'job-db-id',
        segmentId: 'segment_20260605_010203',
        videoS3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
        localVideoPath: '/tmp/job/video/segment_20260605_010203.mkv',
        outputS3Key: 'transcript/job-db-id/segment_20260605_010203.jsonl',
        startTimeOffsetMs: 30000,
      },
      {
        attempts: 2,
        jobId: 'transcript:job-db-id:segment_20260605_010203',
      }
    );
  });

  it('skips scheduling when ASR is unavailable', async () => {
    const { service, addJobToQueue } = createService();
    service.asrService.isAvailable.mockReturnValue(false);

    await expect(
      service.scheduleForVideoSegment({
        id: 'job-db-id',
        videoS3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
      })
    ).resolves.toBe(false);

    expect(addJobToQueue).not.toHaveBeenCalled();
  });
});
