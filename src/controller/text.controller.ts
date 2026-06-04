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
import { StorageError } from '../interface';
import {
  DanmakuMessage,
  DanmakuSegmentInfo,
  ExportRequest,
  ExportResponse,
  QueryDanmakuRequest,
  QueryDanmakuResponse,
  QueryTranscriptRequest,
  QueryTranscriptResponse,
  TranscriptMessage,
  TranscriptSegmentInfo,
} from '../interface/data';
import { DanmakuAssService } from '../service/danmaku-ass.service';
import { DanmakuXmlService } from '../service/danmaku-xml.service';
import { JobService } from '../service/job.service';
import { StorageService } from '../service/storage.service';
import {
  formatTranscriptMessages,
  TranscriptExportFormat,
} from '../utils/transcript-format';

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

  @Inject()
  danmakuXmlService: DanmakuXmlService;

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
    const job = await this.findJobByIdentifier(jobId);
    if (!job) {
      ctx.status = 404;
      return { messages: [], total: 0, hasMore: false };
    }

    const danmakuIndex = (job.metadata as any)?.danmakuIndex;
    if (!danmakuIndex?.segments?.length) {
      return { messages: [], total: 0, hasMore: false };
    }

    const allMessages = await this.collectDanmakuMessages(
      danmakuIndex.segments,
      startTime,
      endTime
    );

    let filteredMessages = allMessages;

    if (types && types.length > 0) {
      filteredMessages = filteredMessages.filter(msg =>
        types.includes(msg.type)
      );
    }

    if (userId) {
      filteredMessages = filteredMessages.filter(msg => msg.userId === userId);
    }

    if (keyword) {
      const lowerKeyword = keyword.toLowerCase();
      filteredMessages = filteredMessages.filter(msg =>
        msg.content?.toLowerCase().includes(lowerKeyword)
      );
    }

    filteredMessages.sort((left, right) => left.timestamp - right.timestamp);

    // 分页
    const total = filteredMessages.length;
    const messages = filteredMessages.slice(offset, offset + limit);
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
    const job = await this.findJobByIdentifier(jobId);
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
    const job = await this.findJobByIdentifier(jobId);
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

    // 导出弹幕
    if (type === 'danmaku') {
      return await this.exportDanmaku(job, index, format);
    }

    return await this.exportTranscript(job, index, format);
  }

  /**
   * GET /api/text/export/download - 下载已生成的文本导出文件
   */
  @Get('/export/download')
  async downloadExport(
    @Query('jobId') jobId: string,
    @Query('type') type: ExportRequest['type'],
    @Query('format') format: ExportRequest['format']
  ) {
    try {
      const job = await this.findJobByIdentifier(jobId);
      if (!job) {
        this.ctx.status = 404;
        return { error: `Job ${jobId} not found` };
      }

      const exportKey = this.getExportKey(job.id, type, format);
      if (!exportKey) {
        this.ctx.status = 400;
        return {
          error: `Export format ${format} for type ${type} is not supported yet`,
        };
      }

      const object = await this.storageService.getObjectStream(exportKey);

      this.ctx.status = 200;
      this.ctx.set(
        'Content-Type',
        object.contentType || 'application/octet-stream'
      );
      if (object.contentLength !== undefined) {
        this.ctx.set('Content-Length', String(object.contentLength));
      }
      if (object.etag) {
        this.ctx.set('ETag', object.etag);
      }
      if (object.lastModified) {
        this.ctx.set('Last-Modified', object.lastModified.toUTCString());
      }
      this.ctx.body = object.body;
      return;
    } catch (error) {
      this.logger.error('Failed to download text export', {
        jobId,
        type,
        format,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof StorageError) {
        const isNotFound = /NoSuchKey|NotFound|StatusCode:\s*404/i.test(
          error.message
        );
        this.ctx.status = isNotFound ? 404 : 502;
        return { error: error.message };
      }

      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * 导出弹幕为 ASS 格式
   */
  private async exportDanmaku(
    job: any,
    index: any,
    format: ExportRequest['format']
  ): Promise<ExportResponse> {
    const allMessages = await this.collectDanmakuMessages(index.segments);

    if (allMessages.length === 0) {
      throw new Error('No danmaku messages found');
    }

    allMessages.sort((left, right) => left.timestamp - right.timestamp);

    let exportContent = '';
    let contentType = 'text/plain';

    const exportKey = this.getExportKey(job.id, 'danmaku', format);
    if (!exportKey) {
      this.ctx.status = 400;
      throw new Error(`Danmaku export format ${format} is not supported yet`);
    }

    if (format === 'ass') {
      exportContent = this.danmakuAssService.messagesToAss(allMessages, {
        removeEmoji: true,
      });
      contentType = 'text/plain';
    } else if (format === 'xml') {
      exportContent = this.danmakuXmlService.messagesToXml(allMessages, {
        metadata: {
          room_id: job.roomId,
          room_title: job.roomName,
          user_name: job.streamerName,
          record_start_time:
            job.startTime?.toISOString?.() || job.createdAt?.toISOString?.(),
        },
      });
      contentType = 'application/xml';
    } else if (format === 'json') {
      exportContent = `${JSON.stringify(allMessages, null, 2)}\n`;
      contentType = 'application/json';
    } else if (format === 'jsonl') {
      exportContent =
        allMessages.map(message => JSON.stringify(message)).join('\n') + '\n';
      contentType = 'application/x-ndjson';
    }

    await this.storageService.upload(
      exportKey,
      Buffer.from(exportContent, 'utf-8'),
      contentType
    );

    const downloadUrl = `/api/text/export/download?jobId=${encodeURIComponent(
      job.jobId || job.id
    )}&type=danmaku&format=${encodeURIComponent(format)}`;

    this.logger.info('Danmaku exported', {
      jobId: job.jobId,
      messageCount: allMessages.length,
      format,
      exportKey,
    });

    return {
      downloadUrl,
      expiresAt: Date.now() + 3600 * 1000,
    };
  }

  private getExportKey(
    jobId: string,
    type: ExportRequest['type'],
    format: ExportRequest['format']
  ): string | null {
    if (
      type === 'danmaku' &&
      ['ass', 'xml', 'json', 'jsonl'].includes(format)
    ) {
      return `danmaku/${jobId}/export.${format}`;
    }
    if (
      type === 'transcript' &&
      ['txt', 'json', 'jsonl', 'srt', 'vtt'].includes(format)
    ) {
      return `transcript/${jobId}/export.${format}`;
    }

    return null;
  }

  private async exportTranscript(
    job: any,
    index: any,
    format: ExportRequest['format']
  ): Promise<ExportResponse> {
    if (!['txt', 'json', 'jsonl', 'srt', 'vtt'].includes(format)) {
      this.ctx.status = 400;
      throw new Error(
        `Transcript export format ${format} is not supported yet`
      );
    }

    const messages = await this.collectTranscriptMessages(index.segments);
    if (messages.length === 0) {
      throw new Error('No transcript messages found');
    }

    const exportKey = this.getExportKey(job.id, 'transcript', format);
    if (!exportKey) {
      this.ctx.status = 400;
      throw new Error(
        `Transcript export format ${format} is not supported yet`
      );
    }

    const content = formatTranscriptMessages(
      messages,
      format as TranscriptExportFormat,
      index.duration || job.duration || 0
    );
    const contentType =
      format === 'json'
        ? 'application/json'
        : format === 'jsonl'
        ? 'application/x-ndjson'
        : format === 'vtt'
        ? 'text/vtt'
        : 'text/plain';

    await this.storageService.upload(
      exportKey,
      Buffer.from(content, 'utf-8'),
      contentType
    );

    const downloadUrl = `/api/text/export/download?jobId=${encodeURIComponent(
      job.jobId || job.id
    )}&type=transcript&format=${encodeURIComponent(format)}`;

    this.logger.info('Transcript exported', {
      jobId: job.jobId,
      messageCount: messages.length,
      format,
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
    const job = await this.findJobByIdentifier(jobId);
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
    const job = await this.findJobByIdentifier(jobId);
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

  private async findJobByIdentifier(jobId: string) {
    return (
      (await this.jobService.findByJobId(jobId)) ||
      (await this.jobService.findById(jobId))
    );
  }

  private async collectDanmakuMessages(
    segments: DanmakuSegmentInfo[],
    startTime?: number,
    endTime?: number
  ): Promise<DanmakuMessage[]> {
    const selectedSegments =
      startTime !== undefined || endTime !== undefined
        ? segments.filter(segment => {
            const segmentStart = segment.startTime;
            const segmentEnd = segment.endTime;
            if (startTime !== undefined && segmentEnd < startTime) {
              return false;
            }
            if (endTime !== undefined && segmentStart > endTime) {
              return false;
            }
            return true;
          })
        : segments;

    const allMessages: DanmakuMessage[] = [];

    for (const segment of selectedSegments) {
      try {
        const data = await this.storageService.download(segment.s3Key);
        const lines = data.toString('utf-8').trim().split('\n');
        const messages = lines
          .filter(line => line.length > 0)
          .map(line => JSON.parse(line) as DanmakuMessage);

        const filteredMessages =
          startTime !== undefined || endTime !== undefined
            ? messages.filter(message => {
                if (startTime !== undefined && message.timestamp < startTime) {
                  return false;
                }
                if (endTime !== undefined && message.timestamp > endTime) {
                  return false;
                }
                return true;
              })
            : messages;

        allMessages.push(...filteredMessages);
      } catch (error) {
        this.logger.warn('Failed to download danmaku segment', {
          segmentId: segment.segmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return allMessages;
  }

  private async collectTranscriptMessages(
    segments: TranscriptSegmentInfo[],
    startTime?: number,
    endTime?: number
  ): Promise<TranscriptMessage[]> {
    const selectedSegments =
      startTime !== undefined || endTime !== undefined
        ? segments.filter(segment => {
            if (startTime !== undefined && segment.endTime < startTime) {
              return false;
            }
            if (endTime !== undefined && segment.startTime > endTime) {
              return false;
            }
            return true;
          })
        : segments;

    const allMessages: TranscriptMessage[] = [];

    for (const segment of selectedSegments) {
      try {
        const data = await this.storageService.download(segment.s3Key);
        const lines = data.toString('utf-8').trim().split('\n');
        const messages = lines
          .filter(line => line.length > 0)
          .map(line => JSON.parse(line) as TranscriptMessage);

        const filteredMessages =
          startTime !== undefined || endTime !== undefined
            ? messages.filter(message => {
                if (startTime !== undefined && message.timestamp < startTime) {
                  return false;
                }
                if (endTime !== undefined && message.timestamp > endTime) {
                  return false;
                }
                return true;
              })
            : messages;

        allMessages.push(...filteredMessages);
      } catch (error) {
        this.logger.warn('Failed to download transcript segment', {
          segmentId: segment.segmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return allMessages.sort((left, right) => left.timestamp - right.timestamp);
  }
}
