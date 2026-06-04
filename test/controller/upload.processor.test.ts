jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { UploadProcessor } from '../../src/processor/upload.processor';

describe('UploadProcessor transcript scheduling', () => {
  const createProcessor = () => {
    const scheduleForVideoSegment = jest.fn().mockResolvedValue(true);
    const processor = new UploadProcessor() as any;
    processor.transcriptScheduler = {
      scheduleForVideoSegment,
    };
    processor.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    return { processor, scheduleForVideoSegment };
  };

  it('queues a transcript job for uploaded video segments', async () => {
    const { processor, scheduleForVideoSegment } = createProcessor();

    await processor.scheduleTranscriptJob({
      id: 'job-db-id',
      s3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
      localPath: '/tmp/segment.mkv',
      contentType: 'video/x-matroska',
      startTimeOffsetMs: 20000,
    });

    expect(scheduleForVideoSegment).toHaveBeenCalledWith({
      id: 'job-db-id',
      videoS3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
      localVideoPath: '/tmp/segment.mkv',
      startTimeOffsetMs: 20000,
    });
  });

  it('delegates ASR availability decisions to the transcript scheduler', async () => {
    const { processor, scheduleForVideoSegment } = createProcessor();
    scheduleForVideoSegment.mockResolvedValue(false);

    await processor.scheduleTranscriptJob({
      id: 'job-db-id',
      s3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
      localPath: '/tmp/segment.mkv',
      contentType: 'video/x-matroska',
    });

    expect(scheduleForVideoSegment).toHaveBeenCalled();
  });
});
