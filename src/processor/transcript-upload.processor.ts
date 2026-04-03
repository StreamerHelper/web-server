import { Framework, IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import * as fs from 'fs/promises';
import {
  TranscriptIndex,
  TranscriptSegmentInfo,
  TranscriptUploadJobData,
} from '../interface/data';
import { JobService } from '../service/job.service';
import { StorageService } from '../service/storage.service';

@Processor('transcript-upload')
export class TranscriptUploadProcessor implements IProcessor {
  @Inject()
  storageService: StorageService;

  @Inject()
  jobService: JobService;

  @Inject()
  bullFramework: Framework;

  @Logger()
  private logger: ILogger;

  async execute(data: TranscriptUploadJobData) {
    const { id, segmentId, s3Key, localPath } = data;

    this.logger.info('Processing transcript upload job', {
      id,
      segmentId,
      s3Key,
    });

    try {
      // 读取本地转录文件
      const fileContent = await fs.readFile(localPath, 'utf-8');

      this.logger.info('Read transcript file for upload', {
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

      // 解析转录消息
      const messages = fileContent
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line));

      // 统计信息
      const wordCount = messages.reduce((sum, msg) => {
        return sum + (msg.text?.split(/\s+/).length || 0);
      }, 0);

      // 统计语言分布
      const languages: Record<string, number> = {};
      for (const msg of messages) {
        const lang = msg.language || 'unknown';
        languages[lang] = (languages[lang] || 0) + 1;
      }

      // 创建分片信息
      const segmentInfo: TranscriptSegmentInfo = {
        segmentId,
        jobId: id,
        startTime: messages[0]?.timestamp || 0,
        endTime: messages[messages.length - 1]?.timestamp || 0,
        messageCount: messages.length,
        wordCount,
        s3Key,
        size: fileContent.length,
        duration: messages[messages.length - 1]?.timestamp || 0,
        createdAt: Date.now(),
      };

      // 更新 Job metadata
      await this.updateTranscriptIndex(id, segmentInfo, languages);

      this.logger.info('Transcript upload completed', {
        id,
        segmentId,
        s3Key,
        messageCount: messages.length,
        wordCount,
      });

      return {
        status: 'completed',
        id,
        segmentId,
        s3Key,
        messageCount: messages.length,
        wordCount,
      };
    } catch (error) {
      this.logger.error('Transcript upload failed', {
        id,
        segmentId,
        localPath,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * 更新转录索引
   */
  private async updateTranscriptIndex(
    id: string,
    segmentInfo: TranscriptSegmentInfo,
    languages: Record<string, number>
  ): Promise<void> {
    const job = await this.jobService.findById(id);
    if (!job) {
      throw new Error(`Job ${id} not found`);
    }

    const currentIndex = (job.metadata as any)
      ?.transcriptIndex as TranscriptIndex;

    let index: TranscriptIndex;

    if (currentIndex) {
      // 更新现有索引
      const existingLanguages = currentIndex.languages || {};

      // 合并语言统计
      for (const [lang, count] of Object.entries(languages)) {
        existingLanguages[lang] = (existingLanguages[lang] || 0) + count;
      }

      index = {
        ...currentIndex,
        segments: [...currentIndex.segments, segmentInfo],
        totalMessages: currentIndex.totalMessages + segmentInfo.messageCount,
        totalWords: (currentIndex.totalWords || 0) + segmentInfo.wordCount,
        audioDuration: currentIndex.audioDuration + segmentInfo.duration,
        languages: existingLanguages,
      };
    } else {
      // 创建新索引
      index = {
        jobId: id,
        streamerId: job.streamerId,
        platform: job.platform,
        roomId: job.roomId,
        startTime: job.startTime?.getTime() || Date.now(),
        endTime: job.endTime?.getTime() || Date.now(),
        duration: job.duration || 0,
        audioDuration: segmentInfo.duration,
        totalMessages: segmentInfo.messageCount,
        totalWords: segmentInfo.wordCount,
        languages,
        segments: [segmentInfo],
        files: {},
      };
    }

    // 更新 Job metadata
    await this.jobService.updateMetadata(id, {
      transcriptIndex: index,
    } as any);
  }
}
