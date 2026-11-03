jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import { UploadProcessor } from '../../src/processor/upload.processor';
import * as fs from 'fs/promises';

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

  it.each([0, 3])(
    'does not upload an empty or changing video (%s bytes)',
    async size => {
      const { processor } = createProcessor();
      processor.storageService = { upload: jest.fn() };
      processor.jobService = {
        addUploadedSegment: jest.fn(),
        addFailedVideoSegment: jest.fn(),
      };
      processor.bullFramework = { getQueue: jest.fn() };
      const stat = jest.spyOn(fs, 'stat').mockResolvedValue({ size: 5 } as any);
      const read = jest
        .spyOn(fs, 'readFile')
        .mockResolvedValue(Buffer.alloc(size));
      const data = {
        id: 'job',
        localPath: '/tmp/video.mkv',
        s3Key: 'raw/job/video/a.mkv',
      };
      try {
        await expect(
          processor.execute(data, { opts: { attempts: 2 }, attemptsMade: 1 })
        ).rejects.toThrow('Video segment is empty or changed while reading');
        expect(processor.storageService.upload).not.toHaveBeenCalled();
        expect(processor.jobService.addUploadedSegment).not.toHaveBeenCalled();
        expect(processor.jobService.addFailedVideoSegment).toHaveBeenCalledWith(
          'job',
          data.s3Key
        );
      } finally {
        stat.mockRestore();
        read.mockRestore();
      }
    }
  );
});
