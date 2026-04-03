import { Framework, IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import * as fs from 'fs/promises';
import { UploadJobData } from '../interface';
import { StorageService } from '../service/storage.service';
import { JobService } from '../service/job.service';

@Processor('upload')
export class UploadProcessor implements IProcessor {
  @Inject()
  storageService: StorageService;

  @Inject()
  jobService: JobService;

  @Inject()
  bullFramework: Framework;

  @Logger()
  private logger: ILogger;

  async execute(data: UploadJobData) {
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

      // BullMQ 会根据 attempts 配置自动重试
      // 这里只处理不可重试的错误，或已达最大重试次数后的清理
      const isRetryable = this.isRetryableError(error);

      if (!isRetryable) {
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
}
