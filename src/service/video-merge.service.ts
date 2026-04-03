import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { spawn } from 'child_process';
import * as fsPromises from 'fs/promises';
import { nanoid } from 'nanoid';
import * as os from 'os';
import * as path from 'path';
import { JobService } from './job.service';
import { StorageService } from './storage.service';
import dayjs = require('dayjs');

@Provide()
@Scope(ScopeEnum.Request)
export class VideoMergeService {
  @Logger()
  private logger: ILogger;

  @Inject()
  private storageService: StorageService;

  @Inject()
  private jobService: JobService;

  /**
   * 合并视频分片并返回下载信息
   * @param jobId 任务 ID
   * @param segmentIndexes 要合并的分片索引数组
   */
  async mergeJobVideos(
    jobId: string,
    segmentIndexes: number[]
  ): Promise<{
    downloadUrl: string;
    filename: string;
    duration: number;
    size: number;
  }> {
    // 获取任务信息
    const job = await this.jobService.findById(jobId);
    if (!job) {
      throw new Error('Job not found');
    }

    const uploadedSegments = job.metadata?.uploadedSegments || [];
    if (uploadedSegments.length === 0) {
      throw new Error('No video segments found');
    }

    // 验证并排序分片索引
    for (const idx of segmentIndexes) {
      if (idx < 0 || idx >= uploadedSegments.length) {
        throw new Error(`Invalid segment index: ${idx}`);
      }
    }
    const sortedIndexes = [...segmentIndexes].sort((a, b) => a - b);

    // 创建临时目录
    const tempDir = path.join(os.tmpdir(), 'video-merge', nanoid());
    await fsPromises.mkdir(tempDir, { recursive: true });

    try {
      // 1. 下载分片到临时目录
      const localSegments: string[] = [];
      for (const idx of sortedIndexes) {
        const s3Key = uploadedSegments[idx];
        const filename = s3Key.split('/').pop() || `segment_${idx}.mkv`;
        const localPath = path.join(tempDir, filename);

        this.logger.info('Downloading segment', { idx, s3Key });
        const buffer = await this.storageService.download(s3Key);
        await fsPromises.writeFile(localPath, buffer);
        localSegments.push(localPath);
      }

      // 2. 合并视频
      const mergedFilename = this.generateMergedFilename(job, sortedIndexes);
      const mergedLocalPath = path.join(tempDir, mergedFilename);

      this.logger.info('Merging segments', {
        segmentCount: localSegments.length,
        outputPath: mergedLocalPath,
      });

      const { duration, fileSize } = await this.mergeSegments(
        localSegments,
        mergedLocalPath
      );

      // 3. 上传到 S3
      const mergedS3Key = `merged/${jobId}/${mergedFilename}`;
      const mergedBuffer = await fsPromises.readFile(mergedLocalPath);

      this.logger.info('Uploading merged video', {
        s3Key: mergedS3Key,
        size: fileSize,
      });
      await this.storageService.upload(
        mergedS3Key,
        mergedBuffer,
        'video/x-matroska'
      );

      // 4. 生成预签名 URL（12 小时有效）
      const downloadUrl = await this.storageService.getSignedUrl(
        mergedS3Key,
        12 * 3600
      );

      return {
        downloadUrl,
        filename: mergedFilename,
        duration,
        size: fileSize,
      };
    } finally {
      // 清理临时目录
      try {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      } catch (e) {
        this.logger.warn('Failed to cleanup temp directory', { tempDir });
      }
    }
  }

  /**
   * 使用 FFmpeg 合并视频分片
   */
  private async mergeSegments(
    segments: string[],
    outputPath: string
  ): Promise<{ duration: number; fileSize: number }> {
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
        '-y', // 覆盖输出文件
        outputPath,
      ]);

      let stderr = '';
      ffmpeg.stderr?.on('data', data => {
        stderr += data.toString();
        this.logger.debug('FFmpeg merge output', { message: data.toString() });
      });

      ffmpeg.on('close', async code => {
        if (code === 0) {
          try {
            const stats = await fsPromises.stat(outputPath);
            const duration = await this.getVideoDuration(outputPath);
            resolve({ duration, fileSize: stats.size });
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`FFmpeg merge failed with code ${code}: ${stderr}`));
        }
      });

      ffmpeg.on('error', err => {
        reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
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

      ffprobe.on('error', err => {
        reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
      });
    });
  }

  /**
   * 生成合并后的文件名
   */
  private generateMergedFilename(job: any, indexes: number[]): string {
    const dateStr = job.startTime
      ? dayjs(job.startTime).format('YYYY年M月D日_HHmm')
      : dayjs().format('YYYY年M月D日_HHmm');

    const rangeStr =
      indexes.length === 1
        ? `分片${indexes[0] + 1}`
        : `分片${indexes[0] + 1}-${indexes[indexes.length - 1] + 1}`;

    // sanitize streamerName for filename
    const safeName = job.streamerName.replace(/[<>:"/\\|?*]/g, '_');

    return `merged_${dateStr}_${safeName}_${rangeStr}.mkv`;
  }
}
