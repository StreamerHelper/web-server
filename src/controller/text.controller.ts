import {
  Body,
  Controller,
  Get,
  ILogger,
  Inject,
  Logger,
  Post,
  Query,
} from '@midwayjs/core';
import { Context } from '@midwayjs/koa';
import {
  DanmakuMessage,
  ExportRequest,
  ExportResponse,
  QueryDanmakuRequest,
  QueryDanmakuResponse,
  QueryTranscriptRequest,
  QueryTranscriptResponse,
} from '../interface/data';
import { DanmakuAssService } from '../service/danmaku-ass.service';
import { JobService } from '../service/job.service';
import { StorageService } from '../service/storage.service';

/**
 * 文本管控 API
 *
 * 提供弹幕和转录文本的查询、搜索、导出功能
 */
@Controller('/api/text')
export class TextController {
  @Inject()
  ctx: Context;

  @Inject()
  jobService: JobService;

  @Inject()
  storageService: StorageService;

  @Inject()
  danmakuAssService: DanmakuAssService;

  @Logger()
  private logger: ILogger;

  /**
   * 查询弹幕
   *
   * GET /api/text/danmaku
   */
  @Get('/danmaku')
  async queryDanmaku(
    @Query() query: QueryDanmakuRequest
  ): Promise<QueryDanmakuResponse> {
    const ctx = this.ctx;
    const {
      jobId,
      startTime,
      endTime,
      types,
      userId,
      keyword,
      limit = 100,
      offset = 0,
    } = query;

    this.logger.info('Query danmaku', {
      jobId,
      startTime,
      endTime,
      types,
      userId,
      keyword,
      limit,
      offset,
    });

    // 获取 Job 信息
    const job = await this.jobService.findByJobId(jobId);
    if (!job) {
      ctx.status = 404;
      return { messages: [], total: 0, hasMore: false };
    }

    const danmakuIndex = (job.metadata as any)?.danmakuIndex;
    if (
      !danmakuIndex ||
      !danmakuIndex.segments ||
      danmakuIndex.segments.length === 0
    ) {
      return { messages: [], total: 0, hasMore: false };
    }

    // 从 S3 下载相关分片数据
    const allMessages: any[] = [];

    // 确定需要下载的分片（根据时间范围）
    let segments = danmakuIndex.segments;
    if (startTime !== undefined || endTime !== undefined) {
      segments = segments.filter(seg => {
        const segStart = seg.startTime;
        const segEnd = seg.endTime;
        if (startTime !== undefined && segEnd < startTime) return false;
        if (endTime !== undefined && segStart > endTime) return false;
        return true;
      });
    }

    // 下载并解析分片数据
    for (const segment of segments) {
      try {
        const data = await this.storageService.download(segment.s3Key);
        const lines = data.toString('utf-8').trim().split('\n');
        const messages = lines
          .filter(line => line.length > 0)
          .map(line => JSON.parse(line));

        // 应用筛选条件
        let filteredMessages = messages;

        // 时间范围筛选
        if (startTime !== undefined || endTime !== undefined) {
          filteredMessages = filteredMessages.filter(msg => {
            if (startTime !== undefined && msg.timestamp < startTime)
              return false;
            if (endTime !== undefined && msg.timestamp > endTime) return false;
            return true;
          });
        }

        // 类型筛选
        if (types && types.length > 0) {
          filteredMessages = filteredMessages.filter(msg =>
            types.includes(msg.type)
          );
        }

        // 用户筛选
        if (userId) {
          filteredMessages = filteredMessages.filter(
            msg => msg.userId === userId
          );
        }

        // 关键词搜索
        if (keyword) {
          const lowerKeyword = keyword.toLowerCase();
          filteredMessages = filteredMessages.filter(msg =>
            msg.content?.toLowerCase().includes(lowerKeyword)
          );
        }

        allMessages.push(...filteredMessages);
      } catch (error) {
        this.logger.warn('Failed to download danmaku segment', {
          segmentId: segment.segmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 分页
    const total = allMessages.length;
    const messages = allMessages.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return { messages, total, hasMore };
  }

  /**
   * 查询转录文本
   *
   * GET /api/text/transcript
   */
  @Get('/transcript')
  async queryTranscript(
    @Query() query: QueryTranscriptRequest
  ): Promise<QueryTranscriptResponse> {
    const ctx = this.ctx;
    const {
      jobId,
      startTime,
      endTime,
      speakerId,
      keyword,
      limit = 100,
      offset = 0,
    } = query;

    this.logger.info('Query transcript', {
      jobId,
      startTime,
      endTime,
      speakerId,
      keyword,
      limit,
      offset,
    });

    // 获取 Job 信息
    const job = await this.jobService.findByJobId(jobId);
    if (!job) {
      ctx.status = 404;
      return { messages: [], total: 0, hasMore: false };
    }

    const transcriptIndex = (job.metadata as any)?.transcriptIndex;
    if (
      !transcriptIndex ||
      !transcriptIndex.segments ||
      transcriptIndex.segments.length === 0
    ) {
      return { messages: [], total: 0, hasMore: false };
    }

    // 从 S3 下载相关分片数据
    const allMessages: any[] = [];

    // 确定需要下载的分片
    let segments = transcriptIndex.segments;
    if (startTime !== undefined || endTime !== undefined) {
      segments = segments.filter(seg => {
        const segStart = seg.startTime;
        const segEnd = seg.endTime;
        if (startTime !== undefined && segEnd < startTime) return false;
        if (endTime !== undefined && segStart > endTime) return false;
        return true;
      });
    }

    // 下载并解析分片数据
    for (const segment of segments) {
      try {
        const data = await this.storageService.download(segment.s3Key);
        const lines = data.toString('utf-8').trim().split('\n');
        const messages = lines
          .filter(line => line.length > 0)
          .map(line => JSON.parse(line));

        // 应用筛选条件
        let filteredMessages = messages;

        // 时间范围筛选
        if (startTime !== undefined || endTime !== undefined) {
          filteredMessages = filteredMessages.filter(msg => {
            if (startTime !== undefined && msg.timestamp < startTime)
              return false;
            if (endTime !== undefined && msg.timestamp > endTime) return false;
            return true;
          });
        }

        // 说话人筛选
        if (speakerId) {
          filteredMessages = filteredMessages.filter(
            msg => msg.speaker?.id === speakerId
          );
        }

        // 关键词搜索
        if (keyword) {
          const lowerKeyword = keyword.toLowerCase();
          filteredMessages = filteredMessages.filter(msg =>
            msg.text?.toLowerCase().includes(lowerKeyword)
          );
        }

        allMessages.push(...filteredMessages);
      } catch (error) {
        this.logger.warn('Failed to download transcript segment', {
          segmentId: segment.segmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 分页
    const total = allMessages.length;
    const messages = allMessages.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return { messages, total, hasMore };
  }

  /**
   * 导出文本内容
   *
   * POST /api/text/export
   */
  @Post('/export')
  async export(@Body() body: ExportRequest): Promise<ExportResponse> {
    const ctx = this.ctx;
    const { jobId, type, format } = body;

    this.logger.info('Export text', { jobId, type, format });

    // 获取 Job 信息
    const job = await this.jobService.findByJobId(jobId);
    if (!job) {
      ctx.status = 404;
      throw new Error(`Job ${jobId} not found`);
    }

    // 根据类型获取索引
    const index =
      type === 'danmaku'
        ? (job.metadata as any)?.danmakuIndex
        : (job.metadata as any)?.transcriptIndex;

    if (!index || !index.segments || index.segments.length === 0) {
      ctx.status = 404;
      throw new Error(`No ${type} data found for job ${jobId}`);
    }

    // 导出弹幕为 ASS 格式
    if (type === 'danmaku' && format === 'ass') {
      return await this.exportDanmakuToAss(job, index);
    }

    // 其他格式暂不支持
    ctx.status = 400;
    throw new Error(
      `Export format ${format} for type ${type} is not supported yet`
    );
  }

  /**
   * 导出弹幕为 ASS 格式
   */
  private async exportDanmakuToAss(
    job: any,
    index: any
  ): Promise<ExportResponse> {
    // 下载所有弹幕分片数据
    const allMessages: DanmakuMessage[] = [];
    for (const segment of index.segments) {
      try {
        const data = await this.storageService.download(segment.s3Key);

        // 根据文件格式解析
        if (segment.s3Key.endsWith('.xml')) {
          // XML 格式：需要解析（暂未实现）
          this.logger.warn('XML danmaku parsing not implemented', {
            segmentId: segment.segmentId,
          });
        } else {
          // JSONL 格式
          const lines = data.toString('utf-8').trim().split('\n');
          const messages = lines
            .filter(line => line.length > 0)
            .map(line => JSON.parse(line) as DanmakuMessage);
          allMessages.push(...messages);
        }
      } catch (error) {
        this.logger.warn('Failed to download danmaku segment', {
          segmentId: segment.segmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (allMessages.length === 0) {
      throw new Error('No danmaku messages found');
    }

    // 生成 ASS 文件
    const assContent = this.danmakuAssService.messagesToAss(allMessages, {
      removeEmoji: true,
    });

    // 上传到 S3
    const exportKey = `danmaku/${job.id}/export.ass`;
    await this.storageService.upload(
      exportKey,
      Buffer.from(assContent, 'utf-8'),
      'text/plain'
    );

    // 生成预签名下载 URL
    const downloadUrl = await this.storageService.getSignedUrl(exportKey, 3600);

    this.logger.info('Danmaku exported to ASS', {
      jobId: job.jobId,
      messageCount: allMessages.length,
      exportKey,
    });

    return {
      downloadUrl,
      expiresAt: Date.now() + 3600 * 1000,
    };
  }

  /**
   * 获取弹幕统计
   *
   * GET /api/text/danmaku/stats
   */
  @Get('/danmaku/stats')
  async getDanmakuStats(@Query('jobId') jobId: string) {
    const ctx = this.ctx;
    const job = await this.jobService.findByJobId(jobId);
    if (!job) {
      ctx.status = 404;
      return null;
    }

    const danmakuIndex = (job.metadata as any)?.danmakuIndex;
    if (!danmakuIndex) {
      return {
        totalMessages: 0,
        uniqueUsers: 0,
        types: {},
        timeRange: { start: null, end: null },
      };
    }

    return {
      totalMessages: danmakuIndex.totalMessages,
      uniqueUsers: danmakuIndex.uniqueUsers,
      types: danmakuIndex.types,
      timeRange: {
        start: danmakuIndex.startTime,
        end: danmakuIndex.endTime,
      },
      segmentCount: danmakuIndex.segments.length,
    };
  }

  /**
   * 获取转录统计
   *
   * GET /api/text/transcript/stats
   */
  @Get('/transcript/stats')
  async getTranscriptStats(@Query('jobId') jobId: string) {
    const ctx = this.ctx;
    const job = await this.jobService.findByJobId(jobId);
    if (!job) {
      ctx.status = 404;
      return null;
    }

    const transcriptIndex = (job.metadata as any)?.transcriptIndex;
    if (!transcriptIndex) {
      return {
        totalMessages: 0,
        totalWords: 0,
        languages: {},
        timeRange: { start: null, end: null },
      };
    }

    return {
      totalMessages: transcriptIndex.totalMessages,
      totalWords: transcriptIndex.totalWords,
      languages: transcriptIndex.languages,
      timeRange: {
        start: transcriptIndex.startTime,
        end: transcriptIndex.endTime,
      },
      audioDuration: transcriptIndex.audioDuration,
      segmentCount: transcriptIndex.segments.length,
    };
  }
}
