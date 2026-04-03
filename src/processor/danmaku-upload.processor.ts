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

  async execute(data: DanmakuUploadJobData) {
    const { id, segmentId, s3Key, localPath, index } = data;

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
      await this.updateDanmakuIndex(id, segmentInfo, index, messages);

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
   * 统计唯一用户数
   */
  private countUniqueUsers(messages: any[]): number {
    const uniqueUserIds = new Set<string>();
    for (const msg of messages) {
      if (msg.userId) {
        uniqueUserIds.add(msg.userId);
      }
    }
    return uniqueUserIds.size;
  }

  /**
   * 更新弹幕索引
   */
  private async updateDanmakuIndex(
    id: string,
    segmentInfo: DanmakuSegmentInfo,
    currentIndex?: DanmakuIndex,
    messages?: any[]
  ): Promise<void> {
    let index: DanmakuIndex;

    if (currentIndex) {
      // 更新现有索引
      index = {
        ...currentIndex,
        segments: [...currentIndex.segments, segmentInfo],
        totalMessages: currentIndex.totalMessages + segmentInfo.messageCount,
      };
      // 合并类型统计
      for (const [type, count] of Object.entries(segmentInfo.types)) {
        index.types[type] = (index.types[type] || 0) + count;
      }
    } else {
      // 创建新索引
      const job = await this.jobService.findById(id);
      if (!job) {
        throw new Error(`Job ${id} not found`);
      }

      index = {
        jobId: id,
        streamerId: job.streamerId,
        platform: job.platform,
        roomId: job.roomId,
        startTime: job.startTime?.getTime() || Date.now(),
        endTime: job.endTime?.getTime() || Date.now(),
        duration: job.duration || 0,
        totalMessages: segmentInfo.messageCount,
        uniqueUsers: messages ? this.countUniqueUsers(messages) : 0,
        types: segmentInfo.types,
        segments: [segmentInfo],
        files: {},
      };
    }

    // 更新 Job metadata
    await this.jobService.updateMetadata(id, {
      danmakuIndex: index,
    } as any);
  }
}
