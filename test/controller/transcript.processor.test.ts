jest.mock('nanoid', () => ({
  nanoid: () => 'mock-job-id',
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TranscriptProcessor } from '../../src/processor/transcript.processor';
import { TranscriptType } from '../../src/interface/data';

describe('TranscriptProcessor', () => {
  it('uses a local video segment before falling back to S3', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-'));
    const localVideoPath = path.join(tempRoot, 'segment_20260605_010203.mkv');
    await fs.writeFile(localVideoPath, Buffer.from('video'));

    const addJobToQueue = jest.fn().mockResolvedValue(undefined);
    const processor = new TranscriptProcessor() as any;
    processor.asrService = {
      isAvailable: jest.fn().mockReturnValue(true),
      transcribeFile: jest.fn().mockResolvedValue({
        jobId: 'job-db-id',
        segmentId: 'segment_20260605_010203',
        messages: [
          {
            id: 'asr-00000',
            timestamp: 100,
            type: TranscriptType.FINAL,
            text: '测试字幕',
            confidence: 1,
            language: 'zh-CN',
            raw: { chunkDurationMs: 1000 },
          },
        ],
        duration: 1000,
        wordCount: 4,
        language: 'zh-CN',
      }),
      saveToFile: jest.fn(async (result, outputPath) => {
        await fs.writeFile(
          outputPath,
          result.messages.map((message: any) => JSON.stringify(message)).join('\n')
        );
      }),
    };
    processor.storageService = {
      download: jest.fn(),
    };
    processor.bullFramework = {
      getQueue: jest.fn().mockReturnValue({ addJobToQueue }),
    };
    processor.logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    try {
      await processor.execute({
        id: 'job-db-id',
        segmentId: 'segment_20260605_010203',
        videoS3Key: 'raw/job-db-id/video/segment_20260605_010203.mkv',
        localVideoPath,
        outputS3Key: 'transcript/job-db-id/segment_20260605_010203.jsonl',
        startTimeOffsetMs: 5000,
      });

      expect(processor.storageService.download).not.toHaveBeenCalled();
      expect(processor.asrService.transcribeFile).toHaveBeenCalledWith(
        localVideoPath,
        expect.objectContaining({
          id: 'job-db-id',
          outputDir: expect.stringContaining(
            'job-db-id-transcript-segment_20260605_010203'
          ),
        })
      );
      expect(addJobToQueue).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'job-db-id',
          segmentId: 'segment_20260605_010203',
          s3Key: 'transcript/job-db-id/segment_20260605_010203.jsonl',
          localPath: expect.stringContaining('segment_20260605_010203.jsonl'),
        })
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
