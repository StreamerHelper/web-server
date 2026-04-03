import { IProcessor, Processor } from '@midwayjs/bullmq';
import { Config, FORMAT, ILogger, Inject, Logger } from '@midwayjs/core';
import * as path from 'path';
import { JOB_STATUS } from '../interface';
import { JobService } from '../service/job.service';
import { PlatformService } from '../service/platform.service';
import { RecorderManager } from '../service/recorder.manager';
import { StreamerService } from '../service/streamer.service';

/**
 * 主播状态轮询任务
 * 使用 BullMQ 重复执行功能，每分钟检查一次活跃主播的直播状态
 */
@Processor('poller', {
  repeat: {
    pattern: FORMAT.CRONTAB.EVERY_PER_10_SECOND,
  },
})
export class PollerProcessor implements IProcessor {
  @Config('streamerhelper.poller')
  private pollerConfig: {
    concurrency: number;
  };

  @Inject()
  streamerService: StreamerService;

  @Inject()
  platformService: PlatformService;

  @Inject()
  jobService: JobService;

  @Inject()
  recorderManager: RecorderManager;

  @Logger()
  private logger: ILogger;

  async execute() {
    try {
      this.logger.debug('Starting poller check');

      // 获取所有活跃主播
      const streamers = await this.streamerService.findActive();

      this.logger.debug('Checking streamers', { count: streamers.length });

      // 并发检查（限制并发数）
      const concurrency = this.pollerConfig.concurrency;

      for (let i = 0; i < streamers.length; i += concurrency) {
        const batch = streamers.slice(i, i + concurrency);
        await Promise.all(batch.map(s => this.checkStreamer(s)));
      }

      this.logger.debug('Poller check completed', {
        totalStreamers: streamers.length,
      });

      return { status: 'completed', checked: streamers.length };
    } catch (error) {
      this.logger.error('Poller error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 检查单个主播状态
   */
  private async checkStreamer(streamer: any): Promise<void> {
    const { id, streamerId, platform } = streamer;

    try {
      // 更新检查时间
      await this.streamerService.updateLastCheckTime(id);

      // 检查是否有活跃的 Job（通过 Job 实体 + 心跳检测）
      const activeJob = await this.jobService.findActiveJobForStreamer(
        streamerId,
        platform
      );
      if (activeJob) {
        this.logger.debug('Active job found, skipping', {
          streamerId,
          platform,
          jobId: activeJob.jobId,
          status: activeJob.status,
        });
        return;
      }

      // 检查直播状态
      const status = await this.platformService.checkLiveStatus(
        platform,
        streamerId
      );

      if (!status.isLive) {
        this.logger.debug('Streamer not live', { streamerId, platform });
        return;
      }

      this.logger.info('Streamer is live, creating recording job', {
        streamerId,
        platform,
        title: status.title,
        viewerCount: status.viewerCount,
      });

      // 获取流地址
      const streamUrl = await this.platformService.getStreamUrl(
        platform,
        streamerId
      );
      const danmakuUrl = await this.platformService.getDanmakuUrl(
        platform,
        streamerId
      );

      // 创建 Job 记录（先设为 PENDING，启动成功后再更新为 RECORDING）
      const job = await this.jobService.create({
        streamerId,
        streamerName: streamer.name,
        roomName: status.title,
        roomId: streamer.roomId,
        platform,
        streamUrl,
        danmakuUrl,
        status: JOB_STATUS.PENDING,
      });

      this.logger.info('Job created', {
        jobId: job.jobId,
        streamerId,
        platform,
      });

      // 直接启动录制
      try {
        await this.recorderManager.startRecording(platform, streamerId, {
          id: job.id,
          jobId: job.jobId,
          platform,
          streamerId,
          streamUrl,
          danmakuUrl,
          roomId: streamer.roomId,
          outputDir: path.join(process.cwd(), 'temp', job.id),
          segmentTime: 10,
        });

        // 启动成功，更新状态为 RECORDING
        await this.jobService.updateStatus(job.id, JOB_STATUS.RECORDING);
        this.logger.info('Recording started successfully', {
          jobId: job.jobId,
        });

        // 更新最后直播时间
        await this.streamerService.updateLastLiveTime(id);
      } catch (startError) {
        // 启动失败，标记 Job 为 FAILED
        await this.jobService.updateStatus(
          job.id,
          JOB_STATUS.FAILED,
          startError instanceof Error ? startError.message : String(startError)
        );
        throw startError;
      }
    } catch (error) {
      this.logger.error('Failed to check streamer', {
        streamerId,
        platform,
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
