jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { UploadProcessor } from '../../src/processor/upload.processor';

describe('UploadProcessor transcript scheduling', () => {
  const createProcessor = () => {
    const addJobToQueue = jest.fn().mockResolvedValue(undefined);
    const processor = new UploadProcessor() as any;
    processor.asrConfig = {
      enabled: true,
      transcribeRecordings: true,
    };
    processor.asrService = {
      isAvailable: jest.fn().mockReturnValue(true),
    };
    processor.bullFramework = {
      getQueue: jest.fn().mockReturnValue({
        addJobToQueue,
      }),
    };
    processor.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    return { processor, addJobToQueue };
  };

  it('queues a transcript job for uploaded video segments', async () => {
    const { processor, addJobToQueue } = createProcessor();

    await processor.scheduleTranscriptJob({
      id: 'job-db-id',
      s3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
      localPath: '/tmp/segment.mkv',
      contentType: 'video/x-matroska',
      startTimeOffsetMs: 20000,
    });

    expect(processor.bullFramework.getQueue).toHaveBeenCalledWith('transcript');
    expect(addJobToQueue).toHaveBeenCalledWith(
      {
        id: 'job-db-id',
        segmentId: 'segment_20260605_010203',
        videoS3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
        outputS3Key: 'transcript/job-db-id/segment_20260605_010203.jsonl',
        startTimeOffsetMs: 20000,
      },
      {
        attempts: 2,
        jobId: 'transcript:job-db-id:segment_20260605_010203',
      }
    );
  });

  it('skips transcript scheduling when ASR is unavailable', async () => {
    const { processor, addJobToQueue } = createProcessor();
    processor.asrService.isAvailable.mockReturnValue(false);

    await processor.scheduleTranscriptJob({
      id: 'job-db-id',
      s3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
      localPath: '/tmp/segment.mkv',
      contentType: 'video/x-matroska',
    });

    expect(addJobToQueue).not.toHaveBeenCalled();
  });
});
