import { ILogger } from '@midwayjs/core';
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

/**
 * FFmpeg 启动选项
 */
export interface FFmpegStartOptions {
  streamUrl: string;
  outputDir: string;
  segmentTime: number;
  listFilePath: string;
  logger?: ILogger;
  id?: string; // 用于日志记录
  /**
   * FFmpeg 有输出时的回调
   * 用于外部维护心跳，避免轮询
   */
  onOutput?: () => void;
}

/**
 * FFmpeg 进程退出事件
 */
export interface FFmpegExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  isNatural: boolean; // 是否为自然退出（直播结束）
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

  private process: ChildProcess | null = null;
  private isStopping = false;
  private exitHandler:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | null = null;
  private logger?: ILogger;
  private id?: string;
  private onOutputCallback: () => void;

  /**
   * 启动 FFmpeg 进程
   */
  start(options: FFmpegStartOptions): void {
    const {
      streamUrl,
      outputDir,
      segmentTime,
      listFilePath,
      logger,
      id,
      onOutput,
    } = options;
    this.logger = logger;
    this.id = id;
    this.onOutputCallback = onOutput;

    if (this.process) {
      throw new Error('FFmpeg process already running');
    }

    this.isStopping = false;

    const outputPattern = path.join(outputDir, 'segment_%Y%m%d_%H%M%S.mkv');
    const ffmpegArgs = this.buildArgs(
      streamUrl,
      segmentTime,
      outputPattern,
      listFilePath
    );

    this.logger?.debug('FFmpeg args', ffmpegArgs.join(' '));

    this.process = spawn('ffmpeg', ffmpegArgs);

    // 设置 exitHandler 引用，确保可以正确移除
    this.exitHandler = (code, signal) => this.handleExit(code, signal);
    this.process.on('exit', this.exitHandler);

    // 监听 stderr 输出，直接回调外部
    this.process.stderr?.on('data', data => {
      const message = data.toString();

      // 记录错误
      if (message.includes('error') || message.includes('Error')) {
        this.logger?.error('FFmpeg error', { id: this.id, message });
      }

      // 通知外部（用于心跳维护）
      this.onOutputCallback();
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
    }
  }

  /**
   * 构建 FFmpeg 命令行参数
   */
  private buildArgs(
    streamUrl: string,
    segmentTime: number,
    outputPattern: string,
    listPath: string
  ): string[] {
    const headers = this.buildHttpHeaders();

    return [
      '-headers',
      headers,
      '-reconnect',
      '1',
      '-reconnect_at_eof',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      streamUrl,
      '-map',
      '0',
      '-c',
      'copy',
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

  /**
   * 构建伪装的 HTTP 请求头
   */
  private buildHttpHeaders(): string {
    const headerObj: Record<string, string> = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'zh-CN,zh;q=0.8,en-US;q=0.5,en;q=0.3',
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
        100 + Math.floor(Math.random() * 20)
      }.0.0.0 Safari/537.36`,
    };

    return Object.entries(headerObj)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
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
