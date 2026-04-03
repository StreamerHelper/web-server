import { IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { JOB_STATUS, TranscodeJobData } from '../interface';
import { FFmpegService } from '../service/ffmpeg.service';
import { JobService } from '../service/job.service';
import { StorageService } from '../service/storage.service';

@Processor('transcode')
export class TranscodeProcessor implements IProcessor {
  @Inject()
  ffmpegService: FFmpegService;

  @Inject()
  storageService: StorageService;

  @Inject()
  jobService: JobService;

  @Logger()
  private logger: ILogger;
  private tempDir: string | null = null;
  private downloadedSegments: string[] = [];

  async execute(data: TranscodeJobData) {
    const { id, rawPath } = data;

    this.logger.info('Starting transcode job', { id, rawPath });

    try {
      await this.jobService.updateStatus(id, JOB_STATUS.PROCESSING);

      // 创建临时目录
      this.tempDir = path.join(process.cwd(), 'temp', `${id}-transcode`);
      await fs.mkdir(this.tempDir, { recursive: true });

      // 列出需要合并的片段
      const segments = await this.listSegments(rawPath);
      this.logger.info('Found segments', { id, count: segments.length });

      if (segments.length === 0) {
        throw new Error('No segments found to merge');
      }

      // 下载所有片段
      await this.downloadSegments(segments);

      // 合并视频
      const outputPath = path.join(this.tempDir, 'merged.mp4');
      const { duration, fileSize } = await this.ffmpegService.mergeSegments(
        this.downloadedSegments,
        outputPath
      );

      this.logger.info('Video merged', { id, duration, fileSize });

      // 上传合并后的视频
      const s3Key = `processed/${id}/full.mp4`;
      await this.storageService.upload(
        s3Key,
        await fs.readFile(outputPath),
        'video/mp4'
      );

      // 更新任务
      await this.jobService.updateVideoPath(id, s3Key);
      await this.jobService.updateDuration(id, duration); // duration 已是毫秒
      await this.jobService.updateStatus(id, JOB_STATUS.COMPLETED);

      // 清理资源
      await this.cleanup();

      return {
        status: JOB_STATUS.COMPLETED,
        id,
        outputPath: s3Key,
        duration,
        fileSize,
      };
    } catch (error) {
      this.logger.error('Transcode job failed', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.jobService.updateStatus(
        id,
        JOB_STATUS.FAILED,
        error instanceof Error ? error.message : String(error)
      );

      // 清理已下载的文件和临时目录
      await this.cleanup();

      throw error;
    }
  }

  /**
   * 列出需要合并的片段
   */
  private async listSegments(rawPath: string): Promise<string[]> {
    // rawPath 格式: raw/{id}/video/
    const prefix = rawPath.replace(/\/$/, '');
    const allFiles = await this.storageService.list(prefix);

    // 只返回 .mkv 文件（FFmpeg segment 输出格式）
    return allFiles.filter(f => f.endsWith('.mkv')).sort();
  }

  /**
   * 下载所有片段
   */
  private async downloadSegments(segments: string[]): Promise<void> {
    this.logger.info('Downloading segments', { count: segments.length });

    const videoDir = path.join(this.tempDir!, 'video');
    await fs.mkdir(videoDir, { recursive: true });

    for (const segment of segments) {
      const filename = path.basename(segment);
      const localPath = path.join(videoDir, filename);

      try {
        const data = await this.storageService.download(segment);
        await fs.writeFile(localPath, data);
        this.downloadedSegments.push(localPath);

        this.logger.debug('Segment downloaded', { segment, filename });
      } catch (error) {
        this.logger.error('Failed to download segment', {
          segment,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info('All segments downloaded', {
      count: this.downloadedSegments.length,
    });
  }

  /**
   * 清理资源
   */
  private async cleanup(): Promise<void> {
    if (this.tempDir) {
      try {
        await fs.rm(this.tempDir, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn('Failed to cleanup temp dir', {
          tempDir: this.tempDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
