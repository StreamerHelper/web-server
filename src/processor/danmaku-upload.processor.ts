import { Framework, IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import {
  DanmakuIndex,
  DanmakuSegmentInfo,
  DanmakuUploadJobData,
} from '../interface/data';
import { JobService } from '../service/job.service';
import { StorageService } from '../service/storage.service';

@Processor('danmaku-upload')
export class DanmakuUploadProcessor implements IProcessor {
  @Inject()
  storageService: StorageService;

  @Inject()
  jobService: JobService;

  @Inject()
  bullFramework: Framework;

  @Logger()
  private logger: ILogger;

  async execute(data: DanmakuUploadJobData, job: any) {
    const { id, segmentId, s3Key, localPath } = data;

    this.logger.info('Processing danmaku upload job', { id, segmentId, s3Key });

    try {
      // 读取本地弹幕文件
      const fs = await import('fs/promises');
      const fileContent = await fs.readFile(localPath, 'utf-8');

      this.logger.info('Read danmaku file for upload', {
        id,
        segmentId,
        localPath,
        size: fileContent.length,
      });

      // 上传到 S3
      await this.storageService.upload(
        s3Key,
        Buffer.from(fileContent, 'utf-8'),
        'application/jsonl'
      );

      await this.jobService.addUploadedDanmakuSegment(id, s3Key);

      // 解析弹幕消息
      const messages = fileContent
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line));

      // 计算时间范围
      const timestamps = messages.map(m => m.timestamp || 0);
      const startTime = timestamps.length > 0 ? Math.min(...timestamps) : 0;
      const endTime = timestamps.length > 0 ? Math.max(...timestamps) : 0;

      // 创建分片信息
      const segmentInfo: DanmakuSegmentInfo = {
        segmentId,
        jobId: id,
        startTime,
        endTime,
        messageCount: messages.length,
        types: this.countByType(messages),
        s3Key,
        size: fileContent.length,
        createdAt: Date.now(),
      };

      // 更新 Job metadata
      await this.updateDanmakuIndex(id, segmentInfo, messages);

      this.logger.info('Danmaku upload completed', {
        id,
        segmentId,
        s3Key,
        messageCount: messages.length,
      });

      return {
        status: 'completed',
        id,
        segmentId,
        s3Key,
        messageCount: messages.length,
      };
    } catch (error) {
      this.logger.error('Danmaku upload failed', {
        id,
        segmentId,
        localPath,
        error: error instanceof Error ? error.message : String(error),
      });

      const maxAttempts = job.opts.attempts || 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
      if (isFinalAttempt) {
        await this.jobService.addFailedDanmakuSegment(id, s3Key);
      }

      throw error;
    }
  }

  /**
   * 统计各类型弹幕数量
   */
  private countByType(messages: any[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const msg of messages) {
      const type = msg.type || 'unknown';
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }

  /**
   * 更新弹幕索引
   */
  private async updateDanmakuIndex(
    id: string,
    segmentInfo: DanmakuSegmentInfo,
    messages?: any[]
  ): Promise<void> {
    const job = await this.jobService.findById(id);
    if (!job) {
      throw new Error(`Job ${id} not found`);
    }

    const metadata = (job.metadata ?? {}) as any;
    const currentIndex = metadata.danmakuIndex as DanmakuIndex | undefined;
    const existingUserIds = Array.isArray(metadata.danmakuUserIds)
      ? metadata.danmakuUserIds.map((userId: unknown) => String(userId))
      : [];
    const mergedUserIds = new Set(existingUserIds);

    for (const message of messages || []) {
      if (message.userId) {
        mergedUserIds.add(String(message.userId));
      }
    }

    const mergedTypes = { ...(currentIndex?.types || {}) };
    for (const [type, count] of Object.entries(segmentInfo.types)) {
      mergedTypes[type] = (mergedTypes[type] || 0) + count;
    }

    const segments = [...(currentIndex?.segments || []), segmentInfo].sort(
      (left, right) =>
        left.startTime - right.startTime || left.createdAt - right.createdAt
    );
    const endTime = Math.max(currentIndex?.endTime || 0, segmentInfo.endTime);

    const index: DanmakuIndex = {
      jobId: id,
      streamerId: job.streamerId,
      platform: job.platform,
      roomId: job.roomId,
      startTime: currentIndex?.startTime || 0,
      endTime,
      duration: Math.max(currentIndex?.duration || 0, endTime),
      totalMessages:
        (currentIndex?.totalMessages || 0) + segmentInfo.messageCount,
      uniqueUsers: mergedUserIds.size,
      types: mergedTypes,
      segments,
      files: currentIndex?.files || {},
    };

    // 更新 Job metadata
    await this.jobService.updateMetadata(id, {
      danmakuIndex: index,
      danmakuUserIds: Array.from(mergedUserIds),
    } as any);
  }
}
