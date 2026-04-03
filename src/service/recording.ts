import { Framework } from '@midwayjs/bullmq';
import { ILogger } from '@midwayjs/core';
import { Application } from '@midwayjs/koa';
import chokidar, { FSWatcher } from 'chokidar';
import * as dayjs from 'dayjs';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import { throttle } from 'lodash';
import * as path from 'path';
import { JOB_STATUS, Platform, SegmentInfo } from '../interface';
import { DanmakuManager } from './danmaku.service';
import { FFmpegExitEvent, FFmpegService } from './ffmpeg.service';
import { HighlightService } from './highlight.service';
import { JobService } from './job.service';

/**
 * 录制选项（由调用方提供）
 */
export interface RecordingInputOptions {
  id: string; // Job 实体 ID
  jobId: string; // Job 显示 ID (UUID)
  platform: Platform;
  streamerId: string;
  streamUrl: string;
  danmakuUrl: string;
  roomId: string;
  outputDir: string;
  segmentTime?: number;
}

/**
 * 录制器配置
 */
export interface RecordingConfig {
  heartbeatInterval: number; // 毫秒
  heartbeatTimeout: number; // 毫秒
  maxRecordingTime: number; // 毫秒
}

/**
 * 完整的录制选项（由 RecorderManager 补充服务依赖）
 */
export interface RecordingOptions extends RecordingInputOptions {
  // 服务依赖（由 RecorderManager 注入）
  services: {
    jobService: JobService;
    danmakuManager: DanmakuManager;
    bullFramework: Framework;
    app: Application;
  };

  // 日志
  logger: ILogger;

  // 录制器配置（可选，默认使用内置值）
  recordingConfig?: Partial<RecordingConfig>;
}

export type RecordingStatus =
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RecordingEndReason =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'heartbeat_timeout'
  | 'ffmpeg_error'
  | 'max_duration';

/**
 * Recording 结束事件
 */
export interface RecordingEndEvent {
  reason: RecordingEndReason;
  error?: string;
  videoSegments: number;
  danmakuSegments: number;
}

interface SegmentRecord {
  filename: string;
  startTime: number;
  endTime: number;
  duration: number;
}

/**
 * Recording 类 - 管理单个录制任务的完整生命周期
 *
 * 职责：
 * - 协调 FFmpeg 录制（通过 FFmpegService）
 * - 管理弹幕收集
 * - 管理 Highlight 检测
 * - 处理心跳更新
 * - 监听视频分片并触发上传
 *
 * 设计说明：
 * - Recording 是一个领域模型类，不是 MidwayJS 服务
 * - 每个实例有独立的配置（id, platform, streamerId 等）
 * - 使用构造函数注入依赖（Constructor Injection）而非 @Inject()
 * - 由 RecorderManager（单例服务）负责创建和管理实例生命周期
 *
 * 这种设计符合 IoC 原则：依赖关系通过构造函数传入，而非内部创建。
 */
export class Recording extends EventEmitter {
  // 事件类型定义
  static readonly EVENT_END = 'end' as const;

  /**
   * 类型化的事件发射
   */
  emitEnd(event: RecordingEndEvent): boolean {
    return this.emit(Recording.EVENT_END, event);
  }

  /**
   * 类型化的事件监听
   */
  onEnd(listener: (event: RecordingEndEvent) => void): this {
    return this.on(Recording.EVENT_END, listener);
  }

  onceEnd(listener: (event: RecordingEndEvent) => void): this {
    return this.once(Recording.EVENT_END, listener);
  }

  // ========== 只读属性 ==========
  readonly id: string;
  readonly jobId: string;
  readonly platform: Platform;
  readonly streamerId: string;
  readonly streamUrl: string;
  readonly danmakuUrl: string;
  readonly roomId: string;
  readonly outputDir: string;
  readonly segmentTime: number;
  readonly videoDir: string;
  readonly danmakuDir: string;
  readonly startTime: number;

  // ========== 服务依赖 ==========
  private jobService: JobService;
  private danmakuManager: DanmakuManager;
  private highlightService: HighlightService | null = null;
  private bullFramework: Framework;
  private app: Application;

  // 日志
  private logger: ILogger;

  /**
   * 目录配置（从 RecordingOptions 解构）
   */
  private pathsConfig: {
    segmentTime: number;
    videoDir: string;
    danmakuDir: string;
    listFilePath: string;
  };

  // ========== 状态 ==========
  private status: RecordingStatus = 'starting';
  private isStopping = false;

  // ========== FFmpeg 服务 ==========
  private ffmpeg: FFmpegService;

  // ========== 录制统计 ==========
  private segmentCount = 0;
  private lastSegmentTime = 0;
  private videoSegments: string[] = [];
  private danmakuSegments: string[] = [];

  // ========== 分片监听相关 ==========
  private listFileWatcher: FSWatcher | null = null;
  private knownSegments = new Set<string>();

  // ========== 弹幕相关 ==========
  private danmakuService: Awaited<ReturnType<DanmakuManager['start']>> | null =
    null;

  // ========== 事件监听器 ==========
  private ffmpegExitHandler: ((event: FFmpegExitEvent) => void) | null = null;
  private highlightEndedHandler: ((event: any) => void) | null = null;
  private danmakuSegmentHandler: ((segment: any) => void) | null = null;
  private danmakuMessageHandler: ((message: any) => void) | null = null;
  private danmakuErrorHandler: ((error: Error) => void) | null = null;

  // ========== 心跳相关 ==========
  private heartbeatTimer: NodeJS.Timeout | null = null; // 心跳超时定时器
  private maxDurationTimer: NodeJS.Timeout | null = null;
  private lastFFmpegOutputTime = 0; // FFmpeg 最后输出时间
  private failureReason: string | null = null;
  private recordingFailed = false;
  private throttledUpdateHeartbeat: (() => void) & { cancel(): void }; // 节流的心跳更新函数

  // ========== 录制器配置 ==========
  private readonly recordingConfig: RecordingConfig;

  constructor(options: RecordingOptions) {
    super();

    // 解构录制信息
    this.id = options.id;
    this.jobId = options.jobId;
    this.platform = options.platform;
    this.streamerId = options.streamerId;
    this.streamUrl = options.streamUrl;
    this.danmakuUrl = options.danmakuUrl;
    this.roomId = options.roomId;
    this.outputDir = options.outputDir;
    this.segmentTime = options.segmentTime ?? 10;
    this.videoDir = path.join(this.outputDir, 'video');
    this.danmakuDir = path.join(this.outputDir, 'danmaku');
    this.startTime = Date.now();

    // 解构服务依赖
    this.jobService = options.services.jobService;
    this.danmakuManager = options.services.danmakuManager;
    this.bullFramework = options.services.bullFramework;
    this.app = options.services.app;

    // 缓存路径配置
    this.pathsConfig = {
      segmentTime: this.segmentTime,
      videoDir: this.videoDir,
      danmakuDir: this.danmakuDir,
      listFilePath: path.join(this.videoDir, 'list.csv'),
    };

    // 录制器配置（使用传入的配置或默认值）
    const defaultConfig: RecordingConfig = {
      heartbeatInterval: 3000, // 3秒
      heartbeatTimeout: 10000, // 10秒
      maxRecordingTime: 24 * 60 * 60 * 1000, // 24小时
    };
    this.recordingConfig = { ...defaultConfig, ...options.recordingConfig };

    // 保存 logger 引用
    this.logger = options.logger;

    // 创建 FFmpeg 服务实例
    this.ffmpeg = new FFmpegService();

    // 初始化节流函数（3 秒内最多执行一次）
    this.throttledUpdateHeartbeat = throttle(
      () => this.updateHeartbeatMetadata(),
      3000,
      { leading: true, trailing: true }
    );
  }

  /**
   * 启动录制
   */
  async start(): Promise<void> {
    this.logger.info('Starting recording', {
      id: this.id,
      jobId: this.jobId,
      platform: this.platform,
      streamerId: this.streamerId,
    });

    try {
      // 1. 创建输出目录
      await fs.mkdir(this.videoDir, { recursive: true });
      await fs.mkdir(this.danmakuDir, { recursive: true });

      // 2. 更新 Job 状态
      await this.jobService.updateStatus(this.id, JOB_STATUS.RECORDING);
      await this.jobService.updateMetadata(this.id, {
        totalSegments: 0,
        uploadedSegments: [],
      });

      // 3. 创建并启动 Highlight 检测（每个 Recording 独立实例）
      const container = this.app.getApplicationContext();
      this.highlightService = await container.getAsync(HighlightService);
      this.highlightService.start(this.id);
      this.logger.debug('Highlight detector started', { id: this.id });

      // 4. 设置 FFmpeg 事件监听
      this.setupFFmpegHandlers();

      // 5. 初始化心跳时间
      this.lastFFmpegOutputTime = Date.now();

      // 6. 启动心跳检查定时器（在 FFmpeg 启动前就绪）
      this.startHeartbeatCheck();

      // 7. 启动 FFmpeg（传入 onOutput 回调用于心跳维护）
      this.ffmpeg.start({
        streamUrl: this.streamUrl,
        outputDir: this.videoDir,
        segmentTime: this.segmentTime,
        listFilePath: this.pathsConfig.listFilePath,
        logger: this.logger,
        id: this.id,
        onOutput: () => {
          this.handleFFmpegOutput();
        }, // FFmpeg 有输出时调用
      });

      // 8. 启动分片监听
      this.startSegmentWatcher();

      // 9. 启动弹幕录制（可选）
      await this.startDanmaku();

      // 10. 设置其他事件监听
      this.setupEventHandlers();

      // 11. 等待录制结束
      this.status = 'recording';
      const endReason = await this.waitForCompletion();

      // 12. 停止录制
      await this.stop(endReason);

      // 13. 触发结束事件
      this.emitEnd({
        reason: endReason,
        videoSegments: this.videoSegments.length,
        danmakuSegments: this.danmakuSegments.length,
      });
    } catch (error) {
      this.logger.error('Recording failed', {
        id: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.recordingFailed = true;
      this.failureReason =
        error instanceof Error ? error.message : String(error);

      await this.stop('failed');

      this.emitEnd({
        reason: 'failed',
        error: this.failureReason || undefined,
        videoSegments: this.videoSegments.length,
        danmakuSegments: this.danmakuSegments.length,
      });
    }
  }

  /**
   * 停止录制
   */
  async stop(reason: RecordingEndReason): Promise<void> {
    if (this.isStopping) {
      return;
    }

    this.isStopping = true;
    this.logger.info('Stopping recording', { id: this.id, reason });

    // 停止心跳定时器
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    // 停止 FFmpeg
    await this.ffmpeg.stop();

    // 停止弹幕
    await this.stopDanmaku();

    // 停止 Highlight 检测
    this.highlightService?.stop();

    // 清理监听器
    this.cleanup();

    // 更新最终状态
    const finalStatus = this.getFinalStatus(reason);
    await this.jobService.updateStatus(
      this.id,
      finalStatus,
      this.failureReason || undefined
    );
    await this.jobService.updateMetadata(this.id, {
      totalSegments: this.videoSegments.length,
    });

    this.status = finalStatus as RecordingStatus;
    this.logger.info('Recording stopped', {
      id: this.id,
      reason,
      finalStatus,
      videoSegments: this.videoSegments.length,
      danmakuSegments: this.danmakuSegments.length,
    });

    // 调度清理任务（10分钟后）
    await this.scheduleCleanup();
  }

  /**
   * 获取录制状态
   */
  getStatus(): RecordingStatus {
    return this.status;
  }

  /**
   * 获取录制信息
   */
  getInfo() {
    return {
      id: this.id,
      jobId: this.jobId,
      platform: this.platform,
      streamerId: this.streamerId,
      status: this.status,
      startTime: this.startTime,
      duration: Date.now() - this.startTime,
      videoSegments: this.videoSegments.length,
      danmakuSegments: this.danmakuSegments.length,
    };
  }

  // ========== 私有方法 ==========

  /**
   * 设置 FFmpeg 事件处理器
   */
  private setupFFmpegHandlers(): void {
    this.ffmpegExitHandler = (event: FFmpegExitEvent) => {
      this.handleFFmpegExit(event);
    };
    this.ffmpeg.on(FFmpegService.EVENT_EXIT, this.ffmpegExitHandler);
  }

  /**
   * 处理 FFmpeg 进程退出
   */
  private handleFFmpegExit(event: FFmpegExitEvent): void {
    if (event.isNatural) {
      this.logger.info('FFmpeg process exited - stream ended', {
        id: this.id,
        code: event.code,
        signal: event.signal,
      });
    } else if (this.isStopping) {
      this.logger.info('FFmpeg process exited - stopped by user', {
        id: this.id,
        code: event.code,
        signal: event.signal,
      });
    } else {
      this.logger.warn('FFmpeg process exited abnormally', {
        id: this.id,
        code: event.code,
        signal: event.signal,
      });
      this.recordingFailed = true;
      this.failureReason = `FFmpeg exited with code ${event.code}`;
    }

    // 处理剩余分片
    this.processListChanges().catch(err => {
      this.logger.error('Failed to process remaining segments', {
        id: this.id,
        error: err.message,
      });
    });
  }

  /**
   * 启动分片监听
   */
  private startSegmentWatcher(): void {
    this.listFileWatcher = chokidar.watch(this.pathsConfig.listFilePath, {
      ignoreInitial: true,
      persistent: true,
    });

    this.listFileWatcher.on('change', () => {
      this.processListChanges().catch(err => {
        this.logger.warn('Failed to process list changes', {
          id: this.id,
          error: err.message,
        });
      });
    });

    this.logger.debug('Started watching list.csv', {
      id: this.id,
      path: this.pathsConfig.listFilePath,
    });
  }

  /**
   * 处理 list.csv 变化
   */
  private async processListChanges(): Promise<void> {
    const record = await this.parseLatestSegment();
    if (record && !this.knownSegments.has(record.filename)) {
      this.knownSegments.add(record.filename);
      await this.handleNewSegment(record.filename, record.duration);
    }
  }

  /**
   * 解析最新的分片记录
   */
  private async parseLatestSegment(): Promise<SegmentRecord | null> {
    try {
      const content = await fs.readFile(this.pathsConfig.listFilePath, 'utf-8');
      const line = content.trim();
      if (!line) return null;

      const parts = line.split(',');
      if (parts.length < 3) return null;

      const filename = parts[0].trim();
      const startTime = parseFloat(parts[1]);
      const endTime = parseFloat(parts[2]);

      return { filename, startTime, endTime, duration: endTime - startTime };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 处理新的视频分片
   */
  private async handleNewSegment(
    filename: string,
    durationSeconds: number
  ): Promise<void> {
    const durationMs = Math.round(durationSeconds * 1000);

    this.logger.debug('New video segment detected', {
      id: this.id,
      filename,
      duration: durationMs,
    });

    const localPath = path.join(this.videoDir, filename);

    try {
      const stats = await fs.stat(localPath);
      const timestamp = this.parseTimestampFromFilename(filename);

      const segmentInfo: SegmentInfo = {
        id: this.id,
        timestamp,
        type: 'video',
        localPath,
        s3Key: `raw/${this.id}/video/${filename}`,
        size: stats.size,
        duration: durationMs,
      };

      this.segmentCount++;
      this.lastSegmentTime = timestamp;

      // 触发上传
      const uploadQueue = this.bullFramework.getQueue('upload');
      if (uploadQueue) {
        await uploadQueue.addJobToQueue(
          {
            id: this.id,
            s3Key: segmentInfo.s3Key,
            localPath: segmentInfo.localPath,
            contentType: 'video/x-matroska',
          },
          {
            attempts: 2,
          }
        );
        this.logger.debug('Upload job added', {
          id: this.id,
          s3Key: segmentInfo.s3Key,
        });
      }

      this.videoSegments.push(segmentInfo.s3Key);
      await this.jobService.addSegment(this.id, durationMs);

      this.logger.debug('Video segment processed', {
        id: this.id,
        filename,
        size: stats.size,
        duration: durationMs,
        segmentCount: this.segmentCount,
      });

      this.emit('segment', segmentInfo);
    } catch (error) {
      this.logger.error('Failed to handle new segment', {
        id: this.id,
        filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 从文件名解析时间戳
   */
  private parseTimestampFromFilename(filename: string): number {
    const match = filename.match(/segment_(\d{8})_(\d{6})\.mkv/);
    if (!match) {
      return Date.now();
    }

    const [_, date, time] = match;
    const isoStr = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(
      6,
      8
    )}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
    return dayjs(isoStr).valueOf();
  }

  /**
   * 启动弹幕录制
   */
  private async startDanmaku(): Promise<void> {
    try {
      this.danmakuService = await this.danmakuManager.start(this.danmakuUrl, {
        id: this.id,
        roomId: this.roomId,
        outputDir: this.danmakuDir,
        segmentTime: 10,
        format: 'jsonl',
      });

      this.logger.debug('Danmaku recording started', { id: this.id });
    } catch (error) {
      this.logger.warn('Failed to start danmaku recording', {
        id: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // 弹幕失败不影响录制
    }
  }

  /**
   * 停止弹幕录制
   */
  private async stopDanmaku(): Promise<void> {
    if (this.danmakuService) {
      try {
        await this.danmakuManager.stop(this.id);
        this.logger.debug('Danmaku recording stopped', { id: this.id });
      } catch (error) {
        this.logger.error('Failed to stop danmaku recording', {
          id: this.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.danmakuService = null;
    }
  }

  /**
   * 处理 FFmpeg 输出（由 FFmpegService 回调）
   * 每次 FFmpeg 有 stderr 输出时调用
   */
  private async handleFFmpegOutput(): Promise<void> {
    this.lastFFmpegOutputTime = Date.now();

    // 节流更新 Job metadata
    this.throttledUpdateHeartbeat();

    // 检查 Job 状态，如果是 STOPPING 则主动停止 FFmpeg
    const currentJob = await this.jobService.findById(this.id);
    if (currentJob?.status === JOB_STATUS.STOPPING) {
      this.logger.info('Job status is STOPPING, stopping FFmpeg');
      await this.ffmpeg.stop();
      return;
    }

    // 重置心跳检查定时器
    this.resetHeartbeatTimer();
  }

  /**
   * 启动心跳检查定时器
   * 在 FFmpeg 启动前调用，确保心跳保护已就绪
   */
  private startHeartbeatCheck(): void {
    // 启动强制超时保护（24小时）
    this.maxDurationTimer = setTimeout(() => {
      this.logger.warn('Recording max duration reached');
      this.resolveEndReason?.('max_duration');
    }, this.recordingConfig.maxRecordingTime);

    // 启动初始心跳定时器
    this.resetHeartbeatTimer();
  }

  /**
   * 重置心跳超时定时器
   * 由 startHeartbeatCheck 初始化，由 handleFFmpegOutput 调用
   */
  private resetHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    this.heartbeatTimer = setTimeout(async () => {
      // 定时器触发 = FFmpeg 已超时无输出
      // 检查 Job 状态
      const currentJob = await this.jobService.findById(this.id);

      if (!currentJob) {
        this.logger.error('Job not found');
        this.resolveEndReason?.('failed');
        return;
      }

      if (
        currentJob.status === JOB_STATUS.CANCELLED ||
        currentJob.status === JOB_STATUS.STOPPING
      ) {
        this.resolveEndReason?.('cancelled');
        return;
      }

      if (currentJob.status === JOB_STATUS.FAILED || this.recordingFailed) {
        this.resolveEndReason?.('failed');
        return;
      }

      // FFmpeg 超时无输出
      this.logger.error('FFmpeg heartbeat timeout');
      this.resolveEndReason?.('heartbeat_timeout');
    }, this.recordingConfig.heartbeatTimeout);
  }

  /**
   * 用于结束录制的 resolve 函数
   */
  private resolveEndReason: ((reason: RecordingEndReason) => void) | null =
    null;

  /**
   * 更新心跳到 Job metadata
   * 节流后的实际执行函数
   */
  private updateHeartbeatMetadata(): void {
    this.jobService
      .updateMetadata(this.id, {
        lastFFmpegOutputTime: this.lastFFmpegOutputTime,
        recordedSegments: this.segmentCount,
        lastSegmentTime: this.lastSegmentTime,
      })
      .catch(err => {
        this.logger.error('Failed to update heartbeat metadata', {
          id: this.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * 等待录制完成
   * 返回一个 Promise，当 resolveEndReason 被调用时 resolve
   */
  private waitForCompletion(): Promise<RecordingEndReason> {
    return new Promise(resolve => {
      this.resolveEndReason = (reason: RecordingEndReason) => {
        // 清理定时器
        if (this.heartbeatTimer) {
          clearTimeout(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (this.maxDurationTimer) {
          clearTimeout(this.maxDurationTimer);
          this.maxDurationTimer = null;
        }
        this.throttledUpdateHeartbeat.cancel();
        this.resolveEndReason = null;
        resolve(reason);
      };
    });
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    // Highlight 事件
    if (this.highlightService) {
      this.highlightEndedHandler = async (event: any) => {
        try {
          this.logger.info('Highlight detected', {
            id: this.id,
            highlightId: event.highlightId,
          });

          const currentJob = await this.jobService.findById(this.id);
          const existingHighlights = currentJob?.metadata?.highlights || [];
          await this.jobService.updateMetadata(this.id, {
            highlights: [...existingHighlights, event.highlight],
          });
        } catch (error) {
          this.logger.error('Failed to save highlight', {
            id: this.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      this.highlightService.on('highlight:ended', this.highlightEndedHandler);
    }

    // 弹幕事件
    if (this.danmakuService) {
      this.danmakuSegmentHandler = async (segment: any) => {
        try {
          this.logger.debug('Danmaku segment completed', {
            id: this.id,
            segmentId: segment.id,
          });

          const s3Key = `danmaku/${this.id}/${segment.id}.jsonl`;

          const danmakuUploadQueue =
            this.bullFramework.getQueue('danmaku-upload');
          if (danmakuUploadQueue) {
            await danmakuUploadQueue.addJobToQueue(
              {
                id: this.id,
                segmentId: segment.id,
                s3Key,
                localPath: segment.localPath,
                index: undefined,
              },
              {
                attempts: 2,
              }
            );
          }

          this.danmakuSegments.push(s3Key);
        } catch (error) {
          this.logger.error('Failed to process danmaku segment', {
            id: this.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      this.danmakuService.on('segment', this.danmakuSegmentHandler);

      this.danmakuMessageHandler = (message: any) => {
        const relativeTimestamp = Date.now() - this.startTime;
        this.highlightService?.handleDanmaku(message, relativeTimestamp);
      };
      this.danmakuService.on('message', this.danmakuMessageHandler);

      this.danmakuErrorHandler = (error: Error) => {
        this.logger.error('Danmaku error', {
          id: this.id,
          error: error.message,
        });
      };
      this.danmakuService.on('error', this.danmakuErrorHandler);
    }
  }

  /**
   * 调度清理任务
   */
  private async scheduleCleanup(): Promise<void> {
    const cleanupQueue = this.bullFramework.getQueue('cleanup');
    if (!cleanupQueue) {
      this.logger.warn('Cleanup queue not found', { id: this.id });
      return;
    }

    try {
      await cleanupQueue.addJobToQueue(
        {
          id: this.id,
          localPath: this.outputDir,
        },
        {
          delay: 10 * 60 * 1000, // 10分钟后
        }
      );

      this.logger.info('Cleanup job scheduled', {
        id: this.id,
        delayMs: 10 * 60 * 1000,
        videoSegments: this.videoSegments.length,
        danmakuSegments: this.danmakuSegments.length,
      });
    } catch (error) {
      this.logger.error('Failed to schedule cleanup', {
        id: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    // 关闭文件监听器
    this.listFileWatcher?.close();
    this.listFileWatcher = null;

    // 移除 FFmpeg 事件监听器
    if (this.ffmpegExitHandler) {
      this.ffmpeg.off(FFmpegService.EVENT_EXIT, this.ffmpegExitHandler);
      this.ffmpegExitHandler = null;
    }

    // 移除 Highlight 事件监听器
    if (this.highlightService && this.highlightEndedHandler) {
      this.highlightService.off('highlight:ended', this.highlightEndedHandler);
      this.highlightEndedHandler = null;
    }

    // 移除弹幕事件监听器
    if (this.danmakuService) {
      if (this.danmakuSegmentHandler) {
        this.danmakuService.off('segment', this.danmakuSegmentHandler);
        this.danmakuSegmentHandler = null;
      }
      if (this.danmakuMessageHandler) {
        this.danmakuService.off('message', this.danmakuMessageHandler);
        this.danmakuMessageHandler = null;
      }
      if (this.danmakuErrorHandler) {
        this.danmakuService.off('error', this.danmakuErrorHandler);
        this.danmakuErrorHandler = null;
      }
    }
  }

  /**
   * 根据结束原因获取最终状态
   */
  private getFinalStatus(reason: RecordingEndReason): JOB_STATUS {
    if (reason === 'cancelled') return JOB_STATUS.CANCELLED;
    if (reason === 'failed' || this.recordingFailed) return JOB_STATUS.FAILED;
    return JOB_STATUS.COMPLETED;
  }
}
