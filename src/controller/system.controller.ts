import { Framework } from '@midwayjs/bullmq';
import {
  App,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
} from '@midwayjs/core';
import { Application, Context } from '@midwayjs/koa';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, updateConfig } from '../config/loader';
import {
  FailedStreamerInfo,
  LiveStreamInfo,
  OfflineStreamerInfo,
  Platform,
  StreamerLiveStatus,
} from '../interface';
import { AsrService } from '../service/asr.service';
import { JobService } from '../service/job.service';
import { PlatformService } from '../service/platform.service';
import { StreamerService } from '../service/streamer.service';

interface UpdateAsrSettingsBody {
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  chunkSeconds?: number;
  concurrency?: number;
  transcribeRecordings?: boolean;
}

@Controller('/api/system')
export class SystemController {
  @Inject()
  ctx: Context;

  @App()
  app: Application;

  @Inject()
  jobService: JobService;

  @Inject()
  streamerService: StreamerService;

  @Inject()
  platformService: PlatformService;

  @Inject()
  bullFramework: Framework;

  @Inject()
  asrService: AsrService;

  /**
   * GET /api/system/health - 健康检查
   */
  @Get('/health')
  async health() {
    return {
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
    };
  }

  /**
   * GET /api/system/info - 系统信息
   */
  @Get('/info')
  async info() {
    try {
      const [jobStats, streamerStats, activeStreamers] = await Promise.all([
        this.jobService.getStats(),
        this.streamerService.getStats(),
        this.streamerService.findActive(),
      ]);

      // 获取队列信息
      const recordingQueue = this.bullFramework.getQueue('recording');
      const transcodeQueue = this.bullFramework.getQueue('transcode');
      const analyzeQueue = this.bullFramework.getQueue('analyze');
      const cleanupQueue = this.bullFramework.getQueue('cleanup');
      const storageDeleteQueue = this.bullFramework.getQueue('storage-delete');
      const transcriptQueue = this.bullFramework.getQueue('transcript');
      const transcriptUploadQueue =
        this.bullFramework.getQueue('transcript-upload');

      const queueStats = {
        recording: {
          waiting: (await recordingQueue?.getWaitingCount()) || 0,
          active: (await recordingQueue?.getActiveCount()) || 0,
        },
        transcode: {
          waiting: (await transcodeQueue?.getWaitingCount()) || 0,
          active: (await transcodeQueue?.getActiveCount()) || 0,
        },
        analyze: {
          waiting: (await analyzeQueue?.getWaitingCount()) || 0,
          active: (await analyzeQueue?.getActiveCount()) || 0,
        },
        cleanup: {
          waiting: (await cleanupQueue?.getWaitingCount()) || 0,
          active: (await cleanupQueue?.getActiveCount()) || 0,
        },
        storageDelete: {
          waiting: (await storageDeleteQueue?.getWaitingCount()) || 0,
          active: (await storageDeleteQueue?.getActiveCount()) || 0,
        },
        transcript: {
          waiting: (await transcriptQueue?.getWaitingCount()) || 0,
          active: (await transcriptQueue?.getActiveCount()) || 0,
        },
        transcriptUpload: {
          waiting: (await transcriptUploadQueue?.getWaitingCount()) || 0,
          active: (await transcriptUploadQueue?.getActiveCount()) || 0,
        },
      };

      // 检查活跃主播的开播状态
      const liveStatusResults = await Promise.allSettled(
        activeStreamers.map(async streamer => {
          try {
            const status = await this.platformService.checkLiveStatus(
              streamer.platform as Platform,
              streamer.streamerId
            );
            return {
              streamer: streamer.toInfo(),
              status,
            };
          } catch (error) {
            return {
              streamer: streamer.toInfo(),
              status: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      );

      // 分类：开播、未开播、检查失败
      const live: StreamerLiveStatus[] = [];
      const offline: StreamerLiveStatus[] = [];
      const failed: StreamerLiveStatus[] = [];

      liveStatusResults.forEach(result => {
        if (result.status === 'fulfilled') {
          const data = result.value;
          if (data.status?.isLive) {
            live.push(data);
          } else if (data.status === null) {
            failed.push(data);
          } else {
            offline.push(data);
          }
        } else {
          failed.push({
            streamer: result.reason?.streamer || null,
            status: null,
            error: result.reason?.message || 'Unknown error',
          });
        }
      });

      // 读取 package.json 获取项目版本
      let version = 'unknown';
      try {
        const packagePath = path.join(process.cwd(), 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
        version = packageJson.version || 'unknown';
      } catch (e) {
        // 如果读取失败，使用默认值
      }

      return {
        timestamp: Date.now(),
        jobs: jobStats,
        streamers: {
          stats: streamerStats,
          live: {
            count: live.length,
            streamers: live.map(
              (s): LiveStreamInfo => ({
                id: s.streamer.id,
                streamerId: s.streamer.streamerId,
                name: s.streamer.name,
                platform: s.streamer.platform,
                title: s.status.title,
                viewerCount: s.status.viewerCount,
                startTime: s.status.startTime,
              })
            ),
          },
          offline: {
            count: offline.length,
            streamers: offline.map(
              (s): OfflineStreamerInfo => ({
                id: s.streamer.id,
                streamerId: s.streamer.streamerId,
                name: s.streamer.name,
                platform: s.streamer.platform,
              })
            ),
          },
          failed: {
            count: failed.length,
            streamers: failed.map(
              (s): FailedStreamerInfo => ({
                id: s.streamer?.id || '',
                streamerId: s.streamer?.streamerId || '',
                name: s.streamer?.name || '',
                platform: s.streamer?.platform || 'bilibili',
                error: s.error || 'Unknown error',
              })
            ),
          },
        },
        queues: queueStats,
        system: {
          platform: process.platform,
          arch: process.arch,
          version,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
      };
    } catch (error) {
      this.ctx.logger.error('Failed to get system info', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/system/asr-settings - 获取 ASR 配置状态（不返回明文 AK）
   */
  @Get('/asr-settings')
  async getAsrSettings(): Promise<Record<string, unknown>> {
    return this.asrService.getPublicStatus();
  }

  /**
   * POST /api/system/asr-settings - 保存 ASR 配置
   */
  @Post('/asr-settings')
  async updateAsrSettings(
    @Body() body: UpdateAsrSettingsBody
  ): Promise<Record<string, unknown>> {
    try {
      const current = getConfig().asr;
      const nextAsr = {
        ...current,
        enabled:
          body.enabled === undefined ? current.enabled : Boolean(body.enabled),
        provider: 'aliyun' as const,
        apiKey:
          body.clearApiKey === true
            ? ''
            : typeof body.apiKey === 'string' && body.apiKey.trim()
            ? body.apiKey.trim()
            : current.apiKey,
        apiKeyEnv:
          typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.trim()
            ? body.apiKeyEnv.trim()
            : current.apiKeyEnv,
        baseUrl:
          typeof body.baseUrl === 'string' && body.baseUrl.trim()
            ? body.baseUrl.trim()
            : current.baseUrl,
        model:
          typeof body.model === 'string' && body.model.trim()
            ? body.model.trim()
            : current.model,
        language:
          typeof body.language === 'string' && body.language.trim()
            ? body.language.trim()
            : current.language,
        chunkSeconds: this.normalizePositiveInteger(
          body.chunkSeconds,
          current.chunkSeconds,
          30,
          1800
        ),
        concurrency: this.normalizePositiveInteger(
          body.concurrency,
          current.concurrency,
          1,
          8
        ),
        transcribeRecordings:
          body.transcribeRecordings === undefined
            ? current.transcribeRecordings
            : Boolean(body.transcribeRecordings),
      };

      updateConfig({
        asr: nextAsr,
      });
      this.asrService.updateConfig(nextAsr);

      return this.asrService.getPublicStatus();
    } catch (error) {
      this.ctx.logger.error('Failed to update ASR settings', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  private normalizePositiveInteger(
    value: unknown,
    fallback: number,
    min: number,
    max: number
  ): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  /**
   * POST /api/system/cleanup - 清理旧数据
   */
  @Post('/cleanup')
  async cleanup(@Query('days') days = 30) {
    try {
      const deletedCount = await this.jobService.cleanupOldJobs(days);

      return {
        success: true,
        deletedCount,
        message: `Deleted ${deletedCount} old jobs`,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to cleanup', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }
}
