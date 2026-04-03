import { IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import { BilibiliSubmissionService } from '../service/bilibili-submission.service';

/**
 * 投稿任务数据
 */
export interface BilibiliSubmissionJobData {
  submissionId: string;
}

/**
 * B站投稿处理器
 *
 * 职责：
 * - 处理投稿任务
 * - 支持断点续传
 * - 由任务派发触发（解耦）
 *
 * 使用方式：
 * 1. 通过 API 创建投稿记录
 * 2. 派发任务到此队列
 * 3. Processor 自动处理投稿流程
 */
@Processor('bilibili-submission')
export class BilibiliSubmissionProcessor implements IProcessor {
  @Inject()
  private submissionService: BilibiliSubmissionService;

  @Logger()
  private logger: ILogger;

  async execute(data: BilibiliSubmissionJobData) {
    const { submissionId } = data;

    this.logger.info('Processing bilibili submission job', { submissionId });

    try {
      await this.submissionService.processSubmission(submissionId);

      this.logger.info('Bilibili submission job completed', { submissionId });

      return {
        status: 'completed',
        submissionId,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error('Bilibili submission job failed', {
        submissionId,
        error: errorMessage,
      });

      // 不抛出错误，让 BullMQ 根据配置决定是否重试
      // 重试逻辑由 service 层的 retryCount 控制
      throw error;
    }
  }
}
