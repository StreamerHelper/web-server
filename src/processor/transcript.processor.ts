import { Framework, IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TranscriptJobData, TranscriptUploadJobData } from '../interface/data';
import { AsrService, AsrServiceOptions } from '../service/asr.service';
import { StorageService } from '../service/storage.service';
import { JobService } from '../service/job.service';

@Processor('transcript')
export class TranscriptProcessor implements IProcessor {
  @Inject()
  asrService: AsrService;

  @Inject()
  storageService: StorageService;

  @Inject()
  jobService: JobService;

  @Inject()
  bullFramework: Framework;

  @Logger()
  private logger: ILogger;

  private tempDir: string | null = null;

  async execute(data: TranscriptJobData) {
    const { id, segmentId, videoS3Key, outputS3Key } = data;

    this.logger.info('Processing transcript job', {
      id,
      segmentId,
      videoS3Key,
    });

    try {
      // TODO: 检查 ASR 服务是否可用
      if (!this.asrService.isAvailable()) {
        this.logger.warn('ASR service is not available, skipping transcript', {
          id,
          segmentId,
        });
        return {
          status: 'skipped',
          id,
          segmentId,
          reason: 'ASR service unavailable',
        };
      }

      // 创建临时目录
      this.tempDir = path.join(process.cwd(), 'temp', `${id}-transcript`);
      await fs.mkdir(this.tempDir, { recursive: true });

      // 下载视频分片
      const videoFileName = path.basename(videoS3Key);
      const localVideoPath = path.join(this.tempDir, videoFileName);
      const videoData = await this.storageService.download(videoS3Key);
      await fs.writeFile(localVideoPath, videoData);

      this.logger.info('Video segment downloaded for transcript', {
        id,
        segmentId,
        localVideoPath,
      });

      // 调用 ASR 服务进行转录
      const asrOptions: AsrServiceOptions = {
        id,
        outputDir: this.tempDir,
        language: 'zh-CN',
        enablePunctuation: true,
        enableInterimResults: false,
      };

      const result = await this.asrService.transcribeFile(
        localVideoPath,
        asrOptions
      );

      this.logger.info('Transcription completed', {
        id,
        segmentId,
        messageCount: result.messages.length,
        duration: result.duration,
      });

      // 保存转录结果到本地
      const localTranscriptPath = path.join(this.tempDir, `${segmentId}.jsonl`);
      await this.asrService.saveToFile(result, localTranscriptPath);

      // 调度上传任务
      const transcriptUploadQueue =
        this.bullFramework.getQueue('transcript-upload');
      if (transcriptUploadQueue) {
        await transcriptUploadQueue.addJobToQueue({
          id,
          segmentId,
          s3Key: outputS3Key,
          localPath: localTranscriptPath,
        } as TranscriptUploadJobData);
      }

      // 清理本地文件
      await this.cleanup();

      return {
        status: 'completed',
        id,
        segmentId,
        messageCount: result.messages.length,
        duration: result.duration,
      };
    } catch (error) {
      this.logger.error('Transcript job failed', {
        id,
        segmentId,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.cleanup();

      throw error;
    }
  }

  /**
   * 清理临时文件
   */
  private async cleanup(): Promise<void> {
    if (this.tempDir) {
      try {
        await fs.rm(this.tempDir, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn('Failed to cleanup temp dir', {
          tempDir: this.tempDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
