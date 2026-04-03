import { IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Logger } from '@midwayjs/core';
import * as fs from 'fs/promises';
import { CleanupJobData } from '../interface';

/**
 * 清理任务处理器
 * FlowProducer 确保 cleanup 只在所有 upload 完成后执行
 */
@Processor('cleanup')
export class CleanupProcessor implements IProcessor {
  @Logger()
  private logger: ILogger;

  async execute(data: CleanupJobData) {
    const { id, localPath } = data;

    this.logger.info('Starting cleanup job', { id, localPath });

    try {
      // 删除整个临时目录
      await fs.rm(localPath, { recursive: true, force: true });

      this.logger.info('Cleanup completed', { id, localPath });
      return { status: 'completed', id };
    } catch (error) {
      // 目录不存在或已删除也算成功
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.info('Directory already removed', { id, localPath });
        return { status: 'completed', id };
      }

      this.logger.error('Cleanup failed', {
        id,
        localPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
