import { Framework, IProcessor, Processor } from '@midwayjs/bullmq';
import { Config, ILogger, Inject, Logger } from '@midwayjs/core';
import * as path from 'path';
import * as fs from 'fs/promises';
import { UploadJobData } from '../interface';
import { TranscriptJobData } from '../interface/data';
import { StorageService } from '../service/storage.service';
import { JobService } from '../service/job.service';
import { BilibiliSubmissionRhythmService } from '../service/bilibili-submission-rhythm.service';
import { AsrService } from '../service/asr.service';

interface AsrQueueConfig {
  enabled?: boolean;
  transcribeRecordings?: boolean;
}

@Processor('upload')
export class UploadProcessor implements IProcessor {
  @Inject()
  storageService: StorageService;

  @Inject()
  jobService: JobService;

  @Inject()
  rhythmService: BilibiliSubmissionRhythmService;

  @Inject()
  asrService: AsrService;

  @Inject()
  bullFramework: Framework;

  @Config('streamerhelper.asr')
  asrConfig: AsrQueueConfig;

  @Logger()
  private logger: ILogger;

  async execute(data: UploadJobData, job: any) {
    const { id, s3Key, localPath, contentType } = data;

    this.logger.info('Processing upload job', { id, s3Key, localPath });

    try {
      // 检查文件是否存在
      const stats = await fs.stat(localPath);
      this.logger.debug('File stats', { id, s3Key, size: stats.size });

      // 读取文件内容
      const fileContent = await fs.readFile(localPath);
      this.logger.info('Read file for upload', {
        id,
        s3Key,
        localPath,
        size: `${(fileContent.length / (1024 * 1024)).toFixed(2)} MB`,
      });

      // 上传到 S3
      await this.storageService.upload(s3Key, fileContent, contentType);

      // 更新 metadata：记录已上传的分片
      await this.jobService.addUploadedSegment(id, s3Key);

      if (s3Key.includes('/video/')) {
        await this.rhythmService
          .handleUploadedVideoSegment(id)
          .catch(error => {
            this.logger.error('Failed to schedule segmented submission', {
              id,
              s3Key,
              error: error instanceof Error ? error.message : String(error),
            });
          });

        await this.scheduleTranscriptJob(data).catch(error => {
          this.logger.error('Failed to schedule transcript job', {
            id,
            s3Key,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }

      this.logger.info('Upload completed', {
        id,
        s3Key,
        size: fileContent.length,
      });

      return {
        status: 'completed',
        id,
        s3Key,
        size: fileContent.length,
      };
    } catch (error) {
      this.logger.error('Upload failed', {
        id,
        s3Key,
        localPath,
        error: error instanceof Error ? error.message : String(error),
      });

      const maxAttempts = job.opts.attempts || 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

      if (isFinalAttempt) {
        await this.jobService.addFailedVideoSegment(id, s3Key);
      }

      // BullMQ 会根据 attempts 配置自动重试
      // 这里只处理不可重试的错误，或已达最大重试次数后的清理
      const isRetryable = this.isRetryableError(error);

      if (!isRetryable && isFinalAttempt) {
        // 不可重试的错误，调度清理
        const cleanupQueue = this.bullFramework.getQueue('cleanup');
        if (cleanupQueue) {
          await cleanupQueue.addJobToQueue({
            id,
            localPath,
          } as any);
          this.logger.info('Scheduled cleanup for non-retryable upload error', {
            id,
            localPath,
          });
        }
      }

      throw error;
    }
  }

  /**
   * 判断错误是否可重试
   * BullMQ 会处理重试次数，这里只判断错误类型
   */
  private isRetryableError(error: unknown): boolean {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // 网络相关错误可重试
    const retryablePatterns = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNREFUSED',
      'socket hang up',
      'timeout',
      'Network',
      '5', // HTTP 5xx 错误
    ];

    return retryablePatterns.some(pattern => errorMessage.includes(pattern));
  }

  private async scheduleTranscriptJob(data: UploadJobData): Promise<void> {
    const { id, s3Key, startTimeOffsetMs = 0 } = data;
    if (!this.asrConfig?.enabled || !this.asrConfig?.transcribeRecordings) {
      return;
    }
    if (!this.asrService.isAvailable()) {
      this.logger.debug('ASR service unavailable, skip transcript scheduling', {
        id,
        s3Key,
      });
      return;
    }

    const transcriptQueue = this.bullFramework.getQueue('transcript');
    if (!transcriptQueue) {
      this.logger.warn('Transcript queue not found', { id, s3Key });
      return;
    }

    const segmentId = this.getSegmentId(s3Key);
    const outputS3Key = `transcript/${id}/${segmentId}.jsonl`;

    await transcriptQueue.addJobToQueue(
      {
        id,
        segmentId,
        videoS3Key: s3Key,
        outputS3Key,
        startTimeOffsetMs,
      } as TranscriptJobData,
      {
        attempts: 2,
        jobId: `transcript:${id}:${segmentId}`,
      }
    );

    this.logger.info('Transcript job scheduled', {
      id,
      segmentId,
      videoS3Key: s3Key,
      outputS3Key,
      startTimeOffsetMs,
    });
  }

  private getSegmentId(s3Key: string): string {
    return path.basename(s3Key).replace(/\.[^.]+$/, '');
  }
}
