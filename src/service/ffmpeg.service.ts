import { ILogger } from '@midwayjs/core';
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { Platform, RecordingQuality } from '../interface';

/**
 * FFmpeg 启动选项
 */
export interface FFmpegStartOptions {
  streamUrl: string;
  outputDir: string;
  segmentTime: number;
  listFilePath: string;
  platform?: Platform;
  roomId?: string;
  requestedQuality?: RecordingQuality;
  effectiveQuality?: RecordingQuality;
  logger?: ILogger;
  failureLogger?: ILogger;
  id?: string; // 用于日志记录
  /**
   * FFmpeg 有输出时的回调
   * 用于外部维护心跳，避免轮询
   */
  onOutput?: (message: string) => void;
}

/**
 * FFmpeg 进程退出事件
 */
export interface FFmpegExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  isNatural: boolean; // 是否为自然退出（直播结束）
}

type FFmpegStderrLevel = 'debug' | 'warn' | 'error';

interface FFmpegStderrClassification {
  level: FFmpegStderrLevel;
  recoverable: boolean;
}

/**
 * FFmpeg 服务
 *
 * 职责：
 * - 启动和停止 FFmpeg 进程
 * - 构建 FFmpeg 命令行参数
 * - 通过回调通知 FFmpeg 输出和退出事件
 *
 * 设计说明：
 * - FFmpegService 不维护心跳状态，只负责通知
 * - 心跳维护由外部（Recording）通过 onOutput 回调处理
 * - 符合观察者模式和依赖倒置原则
 */
export class FFmpegService extends EventEmitter {
  static readonly EVENT_EXIT = 'exit' as const;
  private static readonly STDERR_BUFFER_LIMIT = 80;

  private process: ChildProcess | null = null;
  private isStopping = false;
  private exitHandler:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | null = null;
  private logger?: ILogger;
  private failureLogger?: ILogger;
  private id?: string;
  private onOutputCallback?: (message: string) => void;
  private lastRecoverableWarningAt = 0;
  private suppressedRecoverableWarnings = 0;
  private recentStderrLines: string[] = [];
  private streamUrl?: string;
  private platform?: Platform;
  private roomId?: string;
  private requestedQuality?: RecordingQuality;
  private effectiveQuality?: RecordingQuality;
  private outputDir?: string;
  private listFilePath?: string;
  private segmentTime?: number;
  private ffmpegArgs: string[] = [];

  /**
   * 启动 FFmpeg 进程
   */
  start(options: FFmpegStartOptions): void {
    const {
      streamUrl,
      outputDir,
      segmentTime,
      listFilePath,
      platform,
      roomId,
      requestedQuality,
      effectiveQuality,
      logger,
      failureLogger,
      id,
      onOutput,
    } = options;
    this.logger = logger;
    this.failureLogger = failureLogger;
    this.id = id;
    this.onOutputCallback = onOutput;
    this.lastRecoverableWarningAt = 0;
    this.suppressedRecoverableWarnings = 0;
    this.recentStderrLines = [];
    this.streamUrl = streamUrl;
    this.platform = platform;
    this.roomId = roomId;
    this.requestedQuality = requestedQuality;
    this.effectiveQuality = effectiveQuality;
    this.outputDir = outputDir;
    this.listFilePath = listFilePath;
    this.segmentTime = segmentTime;

    if (this.process) {
      throw new Error('FFmpeg process already running');
    }

    this.isStopping = false;

    const outputPattern = path.join(outputDir, 'segment_%Y%m%d_%H%M%S.mkv');
    const ffmpegArgs = this.buildArgs(
      streamUrl,
      segmentTime,
      outputPattern,
      listFilePath,
      requestedQuality,
      effectiveQuality
    );
    this.ffmpegArgs = [...ffmpegArgs];

    this.logger?.debug('FFmpeg args', ffmpegArgs.join(' '));

    this.process = spawn('ffmpeg', ffmpegArgs);

    this.process.on('error', err => {
      this.logger?.error('Failed to start FFmpeg process', {
        id: this.id,
        error: err.message,
      });
      this.logFailureExit('spawn_error', {
        error: err.message,
      });

      if (!this.process) {
        return;
      }

      if (this.exitHandler) {
        this.process.off('exit', this.exitHandler);
      }

      this.process = null;
      this.exitHandler = null;
      this.emit(FFmpegService.EVENT_EXIT, {
        code: null,
        signal: null,
        isNatural: false,
      });
    });

    // 设置 exitHandler 引用，确保可以正确移除
    this.exitHandler = (code, signal) => this.handleExit(code, signal);
    this.process.on('exit', this.exitHandler);

    // 监听 stderr 输出，直接回调外部
    this.process.stderr?.on('data', data => {
      const message = data.toString();
      this.handleStderrOutput(message);

      // 通知外部（用于心跳维护）
      this.onOutputCallback?.(message);
    });

    this.logger?.debug('FFmpeg started', { id: this.id });
  }

  /**
   * 停止 FFmpeg 进程
   */
  async stop(): Promise<void> {
    if (!this.process || this.isStopping) {
      return;
    }

    this.logger?.info('Stopping FFmpeg', { id: this.id });
    this.isStopping = true;

    // 移除 exit 监听器
    if (this.exitHandler) {
      this.process.off('exit', this.exitHandler);
      this.exitHandler = null;
    }

    // 优雅退出（发送 'q' 命令）
    try {
      const stdin = this.process.stdin;
      if (stdin && !stdin.destroyed) {
        stdin.write('q');
      }
    } catch {
      // 忽略错误
    }

    // 等待进程退出或强制终止
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        if (this.process) {
          this.logger?.warn('FFmpeg did not exit gracefully, force killing', {
            id: this.id,
          });
          this.process.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      this.process!.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = null;
    this.onOutputCallback = undefined;
    this.logger?.info('FFmpeg stopped', { id: this.id });
  }

  /**
   * 检查进程是否正在运行
   */
  isRunning(): boolean {
    return this.process !== null && !this.isStopping;
  }

  /**
   * 处理进程退出
   */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const isNaturalExit = !this.isStopping && code === 0;
    this.process = null;
    this.exitHandler = null;

    const event: FFmpegExitEvent = {
      code,
      signal,
      isNatural: isNaturalExit,
    };

    this.emit(FFmpegService.EVENT_EXIT, event);

    if (isNaturalExit) {
      this.logger?.info('FFmpeg process exited - stream ended', {
        id: this.id,
        code,
        signal,
      });
    } else if (this.isStopping) {
      this.logger?.info('FFmpeg process exited - stopped by user', {
        id: this.id,
        code,
        signal,
      });
    } else {
      this.logger?.warn('FFmpeg process exited abnormally', {
        id: this.id,
        code,
        signal,
      });
      this.logFailureExit('abnormal_exit', { code, signal });
    }
  }

  /**
   * 构建 FFmpeg 命令行参数
   */
  private buildArgs(
    streamUrl: string,
    segmentTime: number,
    outputPattern: string,
    listPath: string,
    requestedQuality?: RecordingQuality,
    effectiveQuality?: RecordingQuality
  ): string[] {
    const headers = this.buildHttpHeaders(streamUrl, this.platform, this.roomId);
    const metadataComment = this.buildMetadataComment(
      requestedQuality,
      effectiveQuality
    );
    const inputOptions = this.buildInputOptions(streamUrl, headers);

    return [
      ...inputOptions,
      '-i',
      streamUrl,
      '-map',
      '0',
      '-c',
      'copy',
      '-metadata',
      `comment=${metadataComment}`,
      '-f',
      'segment',
      '-segment_time',
      segmentTime.toString(),
      '-segment_format',
      'matroska',
      '-reset_timestamps',
      '1',
      '-strftime',
      '1',
      '-segment_list',
      listPath,
      '-segment_list_type',
      'csv',
      '-segment_list_size',
      '1',
      outputPattern,
    ];
  }

  private buildMetadataComment(
    requestedQuality?: RecordingQuality,
    effectiveQuality?: RecordingQuality
  ): string {
    const parts = ['streamerhelper'];
    if (requestedQuality) {
      parts.push(`requested_quality=${requestedQuality}`);
    }
    if (effectiveQuality) {
      parts.push(`effective_quality=${effectiveQuality}`);
    }
    return parts.join(';');
  }

  /**
   * 构建伪装的 HTTP 请求头
   */
  private buildHttpHeaders(
    streamUrl: string,
    platform?: Platform,
    roomId?: string
  ): string {
    const headerObj: Record<string, string> = {
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
        100 + Math.floor(Math.random() * 20)
      }.0.0.0 Safari/537.36`,
      Connection: 'keep-alive',
    };

    const referer = this.buildReferer(streamUrl, platform, roomId);
    const origin = this.buildOrigin(streamUrl, platform);

    if (referer) {
      headerObj['Referer'] = referer;
    }
    if (origin) {
      headerObj['Origin'] = origin;
    }

    return (
      Object.entries(headerObj)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') + '\r\n'
    );
  }

  private buildInputOptions(streamUrl: string, headers: string): string[] {
    const isHttp =
      streamUrl.startsWith('http://') || streamUrl.startsWith('https://');
    if (!isHttp) {
      return [];
    }

    const args = ['-headers', headers];

    if (this.isHlsStream(streamUrl)) {
      // HLS 播放列表本身可以直接读取；对它套用 FLV 的 EOF/重连策略会卡在循环重连。
      args.push('-rw_timeout', '15000000');
      return args;
    }

    return [
      ...args,
      '-seekable',
      '0',
      '-reconnect',
      '1',
      '-reconnect_at_eof',
      '1',
      '-reconnect_on_network_error',
      '1',
      '-reconnect_on_http_error',
      '4xx,5xx',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '10',
      '-reconnect_max_retries',
      '5',
      '-reconnect_delay_total_max',
      '60',
      '-fflags',
      '+discardcorrupt',
      '-rw_timeout',
      '15000000',
      '-multiple_requests',
      '1',
    ];
  }

  private buildReferer(
    streamUrl: string,
    platform?: Platform,
    roomId?: string
  ): string | undefined {
    if (platform === 'bilibili' && roomId) {
      return `https://live.bilibili.com/${roomId}`;
    }
    if (platform === 'huya' && roomId) {
      return `https://www.huya.com/${roomId}`;
    }
    if (platform === 'douyu' && roomId) {
      return `https://www.douyu.com/${roomId}`;
    }
    if (/bilivideo\.com/i.test(streamUrl)) {
      return 'https://live.bilibili.com/';
    }
    return undefined;
  }

  private buildOrigin(streamUrl: string, platform?: Platform): string | undefined {
    if (platform === 'bilibili' || /bilivideo\.com/i.test(streamUrl)) {
      return 'https://live.bilibili.com';
    }
    if (platform === 'huya') {
      return 'https://www.huya.com';
    }
    if (platform === 'douyu') {
      return 'https://www.douyu.com';
    }
    return undefined;
  }

  private isHlsStream(streamUrl: string): boolean {
    return /\.m3u8(?:$|\?)/i.test(streamUrl);
  }

  private handleStderrOutput(message: string): void {
    for (const rawLine of message.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      this.rememberStderrLine(line);

      const classification = this.classifyStderrLine(line);

      if (classification.recoverable) {
        this.logRecoverableNotice(line);
        continue;
      }

      if (classification.level === 'error') {
        this.logger?.error('FFmpeg error', { id: this.id, message: line });
      } else if (classification.level === 'warn') {
        this.logger?.warn('FFmpeg warning', { id: this.id, message: line });
      } else {
        this.logger?.debug('FFmpeg output', { id: this.id, message: line });
      }
    }
  }

  private classifyStderrLine(line: string): FFmpegStderrClassification {
    if (this.isProgressLine(line) || this.isExpectedLifecycleLine(line)) {
      return { level: 'debug', recoverable: false };
    }

    if (this.isRecoverableNetworkLine(line)) {
      return { level: 'warn', recoverable: true };
    }

    if (/\berror\b/i.test(line) || /\bfailed\b/i.test(line)) {
      return { level: 'error', recoverable: false };
    }

    return { level: 'debug', recoverable: false };
  }

  private isProgressLine(line: string): boolean {
    return (
      /^frame=\s*\d+/i.test(line) ||
      /^size=\s*/i.test(line) ||
      /^video:\s*/i.test(line) ||
      /^Stream mapping:/i.test(line)
    );
  }

  private isExpectedLifecycleLine(line: string): boolean {
    return (
      /Press \[q\] to stop/i.test(line) ||
      /^Input #/i.test(line) ||
      /^Output #/i.test(line) ||
      /^Metadata:/i.test(line) ||
      /^Duration:/i.test(line) ||
      /^Stream #/i.test(line)
    );
  }

  private isRecoverableNetworkLine(line: string): boolean {
    return [
      /Will reconnect .*error=End of file/i,
      /Will reconnect .*Connection reset by peer/i,
      /Will reconnect .*Broken pipe/i,
      /Will reconnect .*I\/O error/i,
      /Will reconnect .*timed out/i,
      /\berror=End of file\b/i,
    ].some(pattern => pattern.test(line));
  }

  private logRecoverableNotice(line: string): void {
    const now = Date.now();
    this.suppressedRecoverableWarnings++;

    if (
      this.lastRecoverableWarningAt === 0 ||
      now - this.lastRecoverableWarningAt >= 30000
    ) {
      this.logger?.warn('FFmpeg transient network issue, reconnecting', {
        id: this.id,
        message: line,
        suppressedSinceLastLog: Math.max(
          0,
          this.suppressedRecoverableWarnings - 1
        ),
      });
      this.lastRecoverableWarningAt = now;
      this.suppressedRecoverableWarnings = 0;
      return;
    }

    this.logger?.debug('FFmpeg transient reconnect notice', {
      id: this.id,
      message: line,
    });
  }

  private rememberStderrLine(line: string): void {
    this.recentStderrLines.push(line);
    if (this.recentStderrLines.length > FFmpegService.STDERR_BUFFER_LIMIT) {
      this.recentStderrLines.shift();
    }
  }

  private logFailureExit(
    reason: 'spawn_error' | 'abnormal_exit',
    details: {
      code?: number | null;
      signal?: NodeJS.Signals | null;
      error?: string;
    }
  ): void {
    this.failureLogger?.error('FFmpeg failure exit', {
      id: this.id,
      reason,
      code: details.code ?? null,
      signal: details.signal ?? null,
      error: details.error,
      streamUrl: this.streamUrl,
      platform: this.platform,
      roomId: this.roomId,
      requestedQuality: this.requestedQuality,
      effectiveQuality: this.effectiveQuality,
      outputDir: this.outputDir,
      listFilePath: this.listFilePath,
      segmentTime: this.segmentTime,
      ffmpegArgs: this.ffmpegArgs,
      recentStderrLines: [...this.recentStderrLines],
    });
  }

  /**
   * 合并视频片段
   */
  async mergeSegments(
    segments: string[],
    outputPath: string
  ): Promise<{ duration: number; fileSize: number }> {
    this.logger?.info('Merging segments', {
      segmentCount: segments.length,
      outputPath,
    });

    // 创建文件列表
    const listFile = path.join(path.dirname(outputPath), 'segments.txt');
    const listContent = segments.map(s => `file '${s}'`).join('\n');
    await fsPromises.writeFile(listFile, listContent);

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-c',
        'copy',
        outputPath,
      ]);

      ffmpeg.stderr?.on('data', data => {
        this.logger?.debug('FFmpeg merge output', { message: data.toString() });
      });

      ffmpeg.on('close', async code => {
        if (code === 0) {
          const stats = await fsPromises.stat(outputPath);
          // 获取视频时长
          const duration = await this.getVideoDuration(outputPath);
          resolve({ duration, fileSize: stats.size });
        } else {
          reject(new Error(`FFmpeg merge failed with code ${code}`));
        }
      });
    });
  }

  /**
   * 裁剪视频
   */
  async clipVideo(
    input: string,
    output: string,
    start: number,
    end: number
  ): Promise<{ duration: number; fileSize: number }> {
    this.logger?.info('Clipping video', { input, output, start, end });

    const duration = (end - start) / 1000; // 转换为秒

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-ss',
        (start / 1000).toString(),
        '-i',
        input,
        '-t',
        duration.toString(),
        '-c',
        'copy',
        output,
      ]);

      ffmpeg.stderr?.on('data', data => {
        this.logger?.debug('FFmpeg clip output', { message: data.toString() });
      });

      ffmpeg.on('close', async code => {
        if (code === 0) {
          const stats = await fsPromises.stat(output);
          resolve({ duration: end - start, fileSize: stats.size });
        } else {
          reject(new Error(`FFmpeg clip failed with code ${code}`));
        }
      });
    });
  }

  /**
   * 获取视频时长
   */
  private async getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-i',
        filePath,
        '-show_entries',
        'format=duration',
        '-v',
        'quiet',
        '-of',
        'csv=p=0',
      ]);

      let output = '';
      ffprobe.stdout?.on('data', data => {
        output += data.toString();
      });

      ffprobe.on('close', code => {
        if (code === 0) {
          const duration = parseFloat(output.trim()) * 1000; // 转换为毫秒
          resolve(duration);
        } else {
          reject(new Error(`FFprobe failed with code ${code}`));
        }
      });
    });
  }
}
