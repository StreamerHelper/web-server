import {
  App,
  Body,
  Config,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from '@midwayjs/core';
import { Application, Context } from '@midwayjs/koa';
import * as path from 'path';
import { JOB_STATUS, JobStatus, Platform, StorageError } from '../interface';
import { JobService } from '../service/job.service';
import { PlatformService } from '../service/platform.service';
import { RecorderManager } from '../service/recorder.manager';
import { StorageService } from '../service/storage.service';
import { StreamerService } from '../service/streamer.service';
import { VideoMergeService } from '../service/video-merge.service';
import {
  normalizeAutoDeleteSettings,
  resolveRecordingQuality,
} from '../utils/record-settings';

@Controller('/api/jobs')
export class JobController {
  @Config('streamerhelper.recorder')
  private recorderConfig: {
    heartbeatInterval: number;
    heartbeatTimeout: number;
    maxRecordingTime: number;
  };

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
  recorderManager: RecorderManager;

  @Inject()
  storageService: StorageService;

  @Inject()
  videoMergeService: VideoMergeService;

  /**
   * GET /api/jobs - 获取任务列表或单个任务
   */
  @Get('/')
  async listJobs(
    @Query('id') id?: string,
    @Query('status') status?: JobStatus,
    @Query('streamerId') streamerId?: string,
    @Query('sortBy')
    sortBy: 'createdAt' | 'updatedAt' | 'startTime' | 'endTime' = 'createdAt',
    @Query('sortOrder') sortOrder: 'ASC' | 'DESC' = 'DESC',
    @Query('limit') limit = 50,
    @Query('offset') offset = 0
  ) {
    try {
      // 如果传入 id，返回单个任务
      if (id) {
        const job = await this.jobService.attachSubmissionSummary(
          await this.jobService.findById(id)
        );
        if (!job) {
          this.ctx.status = 404;
          return { error: 'Job not found' };
        }
        return job;
      }

      // 否则返回任务列表
      let result;

      if (status) {
        result = await this.jobService.findByStatus(
          status,
          sortBy,
          sortOrder,
          limit,
          offset
        );
      } else if (streamerId) {
        result = await this.jobService.findByStreamerId(
          streamerId,
          sortBy,
          sortOrder,
          limit,
          offset
        );
      } else {
        result = await this.jobService.findAll(
          sortBy,
          sortOrder,
          limit,
          offset
        );
      }

      return {
        jobs: await this.jobService.attachSubmissionSummaries(result.jobs),
        total: result.total,
        limit,
        offset,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to get jobs', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/jobs/stats - 获取任务统计
   */
  @Get('/stats')
  async getStats() {
    try {
      const stats = await this.jobService.getStats();
      return stats;
    } catch (error) {
      this.ctx.logger.error('Failed to get job stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/jobs/browse - 内容浏览，按日期分组展示所有任务
   */
  @Get('/browse')
  async browseJobs(
    @Query('streamerName') streamerName?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('minSegmentCount') minSegmentCount?: string
  ) {
    try {
      const minSegments = minSegmentCount ? parseInt(minSegmentCount, 10) : undefined;
      const groups = await this.jobService.findAllGroupedByDate(
        streamerName,
        startDate,
        endDate,
        minSegments
      );

      // 转换为数组格式，按日期降序排列
      const result = Object.entries(groups)
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, jobs]) => ({
          date,
          jobs,
        }));

      return { groups: result };
    } catch (error) {
      this.ctx.logger.error('Failed to browse jobs', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/jobs/streamers - 获取所有有录制任务的主播名称列表
   */
  @Get('/streamers')
  async getStreamerNames() {
    try {
      const names = await this.jobService.getStreamerNames();
      return { streamers: names };
    } catch (error) {
      this.ctx.logger.error('Failed to get streamer names', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/jobs/:id - 获取任务详情
   */
  @Get('/:id')
  async getJob(@Param('id') id: string) {
    try {
      const job = await this.jobService.findById(id);

      if (!job) {
        this.ctx.status = 404;
        return { error: 'Job not found' };
      }

      return await this.jobService.attachSubmissionSummary(job);
    } catch (error) {
      this.ctx.logger.error('Failed to get job', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/jobs/:id/cover - 代理任务封面
   */
  @Get('/:id/cover')
  async getJobCover(@Param('id') id: string) {
    try {
      const job = await this.jobService.findById(id);

      if (!job || !job.coverPath) {
        this.ctx.status = 404;
        return { error: 'Job cover not found' };
      }

      const object = await this.storageService.getObjectStream(job.coverPath);

      this.ctx.status = 200;
      this.ctx.set('Content-Type', object.contentType || 'application/octet-stream');
      if (object.contentLength !== undefined) {
        this.ctx.set('Content-Length', String(object.contentLength));
      }
      if (object.etag) {
        this.ctx.set('ETag', object.etag);
      }
      if (object.lastModified) {
        this.ctx.set('Last-Modified', object.lastModified.toUTCString());
      }
      this.ctx.set('Cache-Control', 'private, max-age=3600');
      this.ctx.body = object.body;
      return;
    } catch (error) {
      this.ctx.logger.error('Failed to get job cover', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof StorageError) {
        const isNotFound =
          /NoSuchKey|NotFound|StatusCode:\s*404/i.test(error.message);
        this.ctx.status = isNotFound ? 404 : 502;
        return { error: error.message };
      }

      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/jobs/:id/videos - 获取任务的视频列表
   */
  @Get('/:id/videos')
  async getJobVideos(@Param('id') id: string) {
    try {
      const result = await this.jobService.getJobVideos(id);

      if (!result) {
        this.ctx.status = 404;
        return { error: 'Job not found' };
      }

      // 使用相对路径，避免浏览器直接访问 MinIO 的 localhost/publicEndpoint
      const videosWithUrls = result.videos.map((video: any) => ({
        ...video,
        playUrl: video.url,
      }));

      return {
        ...result,
        videos: videosWithUrls,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to get job videos', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/jobs/:id/videos/:index/stream - 代理单个视频分片
   */
  @Get('/:id/videos/:index/stream')
  async streamJobVideo(
    @Param('id') id: string,
    @Param('index') index: string
  ) {
    try {
      const result = await this.jobService.getJobVideos(id);
      if (!result) {
        this.ctx.status = 404;
        return { error: 'Job not found' };
      }

      const segmentIndex = Number(index);
      if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
        this.ctx.status = 400;
        return { error: 'Invalid segment index' };
      }

      const video = result.videos.find((item: any) => item.index === segmentIndex);
      if (!video) {
        this.ctx.status = 404;
        return { error: 'Video segment not found' };
      }

      const range = this.ctx.get('range') || undefined;
      const object = await this.storageService.getObjectStream(video.s3Key, range);

      this.ctx.status = object.contentRange ? 206 : 200;
      if (object.contentType) {
        this.ctx.set('Content-Type', object.contentType);
      } else {
        this.ctx.set('Content-Type', 'video/x-matroska');
      }
      if (object.contentLength !== undefined) {
        this.ctx.set('Content-Length', String(object.contentLength));
      }
      if (object.contentRange) {
        this.ctx.set('Content-Range', object.contentRange);
      }
      this.ctx.set('Accept-Ranges', object.acceptRanges || 'bytes');
      if (object.etag) {
        this.ctx.set('ETag', object.etag);
      }
      if (object.lastModified) {
        this.ctx.set('Last-Modified', object.lastModified.toUTCString());
      }
      this.ctx.body = object.body;
      return;
    } catch (error) {
      this.ctx.logger.error('Failed to stream job video', {
        id,
        index,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof StorageError) {
        const message = error.message;
        const isNotFound =
          /NoSuchKey|NotFound|StatusCode:\s*404/i.test(message);
        this.ctx.status = isNotFound ? 404 : 502;
        return { error: error.message };
      }

      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/jobs/:id/videos/merge - 合并视频分片
   */
  @Post('/:id/videos/merge')
  async mergeVideos(
    @Param('id') id: string,
    @Body() body: { segments: number[] }
  ) {
    try {
      const { segments } = body;

      if (!segments || !Array.isArray(segments) || segments.length === 0) {
        this.ctx.status = 400;
        return { error: 'segments must be a non-empty array' };
      }

      const result = await this.videoMergeService.mergeJobVideos(id, segments);

      return {
        ...result,
        downloadUrl: `/api/jobs/${id}/videos/merged/download?filename=${encodeURIComponent(
          result.filename
        )}`,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to merge videos', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return {
        error: error instanceof Error ? error.message : 'Internal server error',
      };
    }
  }

  /**
   * GET /api/jobs/:id/videos/merged/download - 代理合并后视频下载
   */
  @Get('/:id/videos/merged/download')
  async downloadMergedVideo(
    @Param('id') id: string,
    @Query('filename') filename?: string
  ) {
    try {
      const safeFilename = filename?.trim();
      if (
        !safeFilename ||
        safeFilename.includes('/') ||
        safeFilename.includes('\\')
      ) {
        this.ctx.status = 400;
        return { error: 'Invalid filename' };
      }

      const s3Key = `merged/${id}/${safeFilename}`;
      const range = this.ctx.get('range') || undefined;
      const object = await this.storageService.getObjectStream(s3Key, range);

      this.ctx.status = object.contentRange ? 206 : 200;
      this.ctx.set('Content-Type', object.contentType || 'video/x-matroska');
      if (object.contentLength !== undefined) {
        this.ctx.set('Content-Length', String(object.contentLength));
      }
      if (object.contentRange) {
        this.ctx.set('Content-Range', object.contentRange);
      }
      this.ctx.set('Accept-Ranges', object.acceptRanges || 'bytes');
      if (object.etag) {
        this.ctx.set('ETag', object.etag);
      }
      if (object.lastModified) {
        this.ctx.set('Last-Modified', object.lastModified.toUTCString());
      }
      this.ctx.body = object.body;
      return;
    } catch (error) {
      this.ctx.logger.error('Failed to download merged video', {
        id,
        filename,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof StorageError) {
        const isNotFound =
          /NoSuchKey|NotFound|StatusCode:\s*404/i.test(error.message);
        this.ctx.status = isNotFound ? 404 : 502;
        return { error: error.message };
      }

      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/jobs/start - 手动启动录制
   */
  @Post('/start')
  async startJob(@Body() body: { streamerId: string; platform: Platform }) {
    const { streamerId, platform } = body;

    try {
      // 验证输入
      if (!streamerId || !platform) {
        this.ctx.status = 400;
        return { error: 'Missing required fields: streamerId, platform' };
      }

      // 检查是否有活跃的 Job（通过 Job 实体 + 心跳检测）
      const activeJob = await this.jobService.findActiveJobForStreamer(
        streamerId,
        platform,
        this.recorderConfig.heartbeatTimeout * 1000
      );
      if (activeJob) {
        this.ctx.status = 409;
        return {
          error: 'Already recording',
          streamerId,
          platform,
          activeJobId: activeJob.jobId,
        };
      }

      // 检查直播状态
      const status = await this.platformService.checkLiveStatus(
        platform,
        streamerId
      );
      if (!status.isLive) {
        this.ctx.status = 400;
        return {
          error: 'Stream is not live',
          status,
        };
      }

      // 获取主播信息以获取 roomId
      const streamer = await this.streamerService.findByStreamerId(streamerId);
      if (!streamer) {
        this.ctx.status = 404;
        return { error: 'Streamer not found' };
      }

      const requestedQuality = resolveRecordingQuality(
        streamer.recordSettings?.quality
      );
      const autoDelete = normalizeAutoDeleteSettings(
        streamer.recordSettings?.autoDelete
      );
      const resolvedStream = await this.platformService.resolveStream(
        platform,
        streamerId,
        requestedQuality
      );
      const danmakuUrl = await this.platformService.getDanmakuUrl(
        platform,
        streamerId
      );

      // 创建任务记录（先设为 PENDING）
      const job = await this.jobService.create({
        streamerId,
        streamerName: streamer.name,
        roomName: status.title,
        roomId: streamer.roomId,
        platform,
        streamUrl: resolvedStream.url,
        danmakuUrl,
        status: JOB_STATUS.PENDING,
        metadata: {
          stream_url: resolvedStream.url,
          danmaku_url: danmakuUrl,
          requestedQuality,
          effectiveQuality: resolvedStream.effectiveQuality,
          qualityApplied: resolvedStream.qualityApplied,
          qualityNote: resolvedStream.note,
          autoDelete,
        },
      });

      this.ctx.logger.info(`Job created manually: ${job.jobId}`);

      // 直接启动录制
      try {
        await this.recorderManager.startRecording(platform, streamerId, {
          id: job.id,
          jobId: job.jobId,
          platform,
          streamerId,
          streamUrl: resolvedStream.url,
          danmakuUrl,
          roomId: streamer.roomId,
          outputDir: path.join(process.cwd(), 'temp', job.id),
          segmentTime: 10,
          requestedQuality,
          effectiveQuality: resolvedStream.effectiveQuality,
          qualityApplied: resolvedStream.qualityApplied,
          qualityNote: resolvedStream.note,
        });

        this.ctx.logger.info(`Recording started manually: ${job.jobId}`);
      } catch (startError) {
        // 启动失败，标记 Job 为 FAILED
        await this.jobService.updateStatus(
          job.id,
          JOB_STATUS.FAILED,
          startError instanceof Error ? startError.message : String(startError)
        );
        throw startError;
      }

      this.ctx.status = 201;
      return {
        jobId: job.jobId,
        streamerId,
        platform,
        status: JOB_STATUS.RECORDING,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to start job', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/jobs/:id/stop - 停止录制
   */
  @Post('/:id/stop')
  async stopJob(@Param('id') id: string) {
    try {
      const job = await this.jobService.findById(id);

      if (!job) {
        this.ctx.status = 404;
        return { error: 'Job not found' };
      }

      // 使用 RecorderManager 停止录制
      await this.recorderManager.stopRecording(
        job.platform as Platform,
        job.streamerId
      );

      this.ctx.logger.info(`Job stop requested: ${id}`);

      return {
        success: true,
        status: JOB_STATUS.STOPPING,
        message: 'Job will stop shortly',
      };
    } catch (error) {
      this.ctx.logger.error('Failed to stop job', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/jobs/:id/delete - 删除任务
   */
  @Post('/:id/delete')
  async deleteJob(@Param('id') id: string) {
    try {
      const job = await this.jobService.findById(id);

      if (!job) {
        this.ctx.status = 404;
        return { error: 'Job not found' };
      }

      // 只能删除已完成的任务
      if (
        job.status === JOB_STATUS.RECORDING ||
        job.status === JOB_STATUS.PROCESSING
      ) {
        this.ctx.status = 400;
        return { error: 'Cannot delete active job' };
      }

      const deleteResult = await this.jobService.deleteJobStorage(id, 'manual');
      await this.jobService.cancel(id);

      return {
        success: true,
        message: 'Job deleted',
        deletedKeys: deleteResult.deletedKeys.length,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to delete job', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/jobs/:id/retry - 重试任务
   */
  @Post('/:id/retry')
  async retryJob(@Param('id') id: string) {
    try {
      const oldJob = await this.jobService.findById(id);

      if (!oldJob) {
        this.ctx.status = 404;
        return { error: 'Job not found' };
      }

      // 检查是否有活跃的 Job（通过 Job 实体 + 心跳检测）
      const activeJob = await this.jobService.findActiveJobForStreamer(
        oldJob.streamerId,
        oldJob.platform as Platform,
        this.recorderConfig.heartbeatTimeout * 1000
      );
      if (activeJob) {
        this.ctx.status = 409;
        return {
          error: 'Already recording',
          streamerId: oldJob.streamerId,
          platform: oldJob.platform,
          activeJobId: activeJob.jobId,
        };
      }

      // 重新检查直播状态
      const status = await this.platformService.checkLiveStatus(
        oldJob.platform as Platform,
        oldJob.streamerId
      );

      if (!status.isLive) {
        this.ctx.status = 400;
        return {
          error: 'Stream is not live',
          status,
        };
      }

      // 获取流地址
      const streamer = await this.streamerService.findByStreamerId(
        oldJob.streamerId
      );
      const requestedQuality = resolveRecordingQuality(
        streamer?.recordSettings?.quality
      );
      const autoDelete = normalizeAutoDeleteSettings(
        streamer?.recordSettings?.autoDelete
      );
      const resolvedStream = await this.platformService.resolveStream(
        oldJob.platform as Platform,
        oldJob.streamerId,
        requestedQuality
      );
      const danmakuUrl = await this.platformService.getDanmakuUrl(
        oldJob.platform as Platform,
        oldJob.streamerId
      );

      // 创建新任务（先设为 PENDING）
      const newJob = await this.jobService.create({
        streamerId: oldJob.streamerId,
        streamerName: oldJob.streamerName,
        roomName: status.title,
        roomId: oldJob.roomId,
        platform: oldJob.platform,
        streamUrl: resolvedStream.url,
        danmakuUrl,
        status: JOB_STATUS.PENDING,
        metadata: {
          stream_url: resolvedStream.url,
          danmaku_url: danmakuUrl,
          requestedQuality,
          effectiveQuality: resolvedStream.effectiveQuality,
          qualityApplied: resolvedStream.qualityApplied,
          qualityNote: resolvedStream.note,
          autoDelete,
        },
      });

      this.ctx.logger.info(`Retry job created: ${id} -> ${newJob.jobId}`);

      // 直接启动录制
      try {
        await this.recorderManager.startRecording(
          oldJob.platform as Platform,
          oldJob.streamerId,
          {
            id: newJob.id,
            jobId: newJob.jobId,
            platform: oldJob.platform as Platform,
            streamerId: oldJob.streamerId,
            streamUrl: resolvedStream.url,
            danmakuUrl,
            roomId: oldJob.roomId,
            outputDir: path.join(process.cwd(), 'temp', newJob.id),
            segmentTime: 10,
            requestedQuality,
            effectiveQuality: resolvedStream.effectiveQuality,
            qualityApplied: resolvedStream.qualityApplied,
            qualityNote: resolvedStream.note,
          }
        );

        this.ctx.logger.info(`Retry recording started: ${newJob.jobId}`);
      } catch (startError) {
        // 启动失败，标记 Job 为 FAILED
        await this.jobService.updateStatus(
          newJob.id,
          JOB_STATUS.FAILED,
          startError instanceof Error ? startError.message : String(startError)
        );
        throw startError;
      }

      this.ctx.status = 201;
      return { newJobId: newJob.jobId };
    } catch (error) {
      this.ctx.logger.error('Failed to retry job', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }
}
