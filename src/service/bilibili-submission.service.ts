import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  BilibiliSubmissionEntity,
  PartStatus,
  SubmissionPart,
  SubmissionStatus,
} from '../entity/bilibili-submission.entity';
import { BilibiliSubmissionRepository } from '../repository/bilibili-submission.repository';
import { BilibiliUploadService, VideoPart } from './bilibili-upload.service';
import { StorageService } from './storage.service';
import { JobService } from './job.service';
import { StreamerService } from './streamer.service';

/**
 * 每个分P的目标时长（10分钟 = 600秒）
 */
const PART_DURATION_SECONDS = 600;

/**
 * 每个分片的时长（10秒）
 */
const SEGMENT_DURATION_SECONDS = 10;

/**
 * 创建投稿的输入参数
 */
export interface CreateSubmissionInput {
  jobId: string;
  title: string;
  description?: string;
  tags?: string[];
  tid?: number;
  cover?: string;
  copyright?: number;
  source?: string;
  dynamic?: string;
}

/**
 * B站投稿服务
 * 负责管理投稿流程：合并分片、上传、提交
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class BilibiliSubmissionService {
  @Logger()
  private logger: ILogger;

  @Inject()
  private submissionRepository: BilibiliSubmissionRepository;

  @Inject()
  private uploadService: BilibiliUploadService;

  @Inject()
  private storageService: StorageService;

  @Inject()
  private jobService: JobService;

  @Inject()
  private streamerService: StreamerService;

  /**
   * 创建投稿任务
   * 根据 Job 中的视频分片，规划分P结构
   */
  async createSubmission(
    input: CreateSubmissionInput
  ): Promise<BilibiliSubmissionEntity> {
    // 获取 Job 信息 (input.jobId 是 jobId 字符串，不是 UUID)
    const job = await this.jobService.findByJobId(input.jobId);
    if (!job) {
      throw new Error(`Job not found: ${input.jobId}`);
    }

    if (
      !job.metadata?.uploadedSegments ||
      job.metadata.uploadedSegments.length === 0
    ) {
      throw new Error('No uploaded segments found for this job');
    }

    // 获取所有已上传的视频分片
    const s3Keys = job.metadata.uploadedSegments.filter(key =>
      key.includes('/video/')
    );

    if (s3Keys.length === 0) {
      throw new Error('No video segments found');
    }

    // 规划分P结构
    const parts = this.planParts(s3Keys);

    this.logger.info('Creating submission', {
      jobId: input.jobId,
      totalSegments: s3Keys.length,
      totalParts: parts.length,
    });

    // 创建投稿记录
    const submission = await this.submissionRepository.create({
      jobId: input.jobId,
      title: input.title,
      description: input.description || '',
      tags: input.tags || [],
      tid: input.tid || 171,
      cover: input.cover,
      copyright: input.copyright || 1,
      source: input.source,
      dynamic: input.dynamic,
      status: SubmissionStatus.PENDING,
      parts,
      totalParts: parts.length,
      completedParts: 0,
    });

    return submission;
  }

  /**
   * 规划分P结构
   * 将分片按照每10分钟一个分P进行分组
   */
  private planParts(s3Keys: string[]): SubmissionPart[] {
    // 按 S3 key 排序（文件名包含时间戳）
    const sortedKeys = [...s3Keys].sort();

    // 计算每个分P包含的分片数（600秒 / 10秒 = 60个分片）
    const segmentsPerPart = Math.floor(
      PART_DURATION_SECONDS / SEGMENT_DURATION_SECONDS
    );

    const parts: SubmissionPart[] = [];
    let currentPart: string[] = [];

    for (const key of sortedKeys) {
      currentPart.push(key);

      if (currentPart.length >= segmentsPerPart) {
        parts.push({
          index: parts.length + 1,
          s3Keys: [...currentPart],
          status: PartStatus.PENDING,
        });
        currentPart = [];
      }
    }

    // 处理剩余的分片
    if (currentPart.length > 0) {
      parts.push({
        index: parts.length + 1,
        s3Keys: currentPart,
        status: PartStatus.PENDING,
      });
    }

    return parts;
  }

  /**
   * 处理投稿（由 Processor 调用）
   * 支持断点续传
   */
  async processSubmission(submissionId: string): Promise<void> {
    const submission = await this.submissionRepository.findById(submissionId);
    if (!submission) {
      throw new Error(`Submission not found: ${submissionId}`);
    }

    // 获取最新的 streamer 信息并更新投稿配置
    await this.updateSubmissionFromStreamer(submission);

    this.logger.info('Processing submission', {
      submissionId,
      status: submission.status,
      totalParts: submission.totalParts,
      completedParts: submission.completedParts,
    });

    // 更新状态为上传中
    await this.submissionRepository.updateStatus(
      submissionId,
      SubmissionStatus.UPLOADING
    );

    try {
      // 创建临时目录（使用项目根目录的 temp 文件夹）
      const projectRoot = path.resolve(__dirname, '..', '..');
      const tempBaseDir = path.join(projectRoot, 'temp', 'submissions');
      await fs.mkdir(tempBaseDir, { recursive: true });
      const tempDir = await fs.mkdtemp(path.join(tempBaseDir, 'submission-'));

      // 处理每个分P
      const uploadedParts: Array<{ title: string; filename: string }> = [];

      for (const part of submission.parts) {
        // 跳过已完成的分P
        if (part.status === PartStatus.COMPLETED && part.filename) {
          uploadedParts.push({
            title: `P${part.index}`,
            filename: part.filename,
          });
          continue;
        }

        this.logger.info('Processing part', {
          submissionId,
          partIndex: part.index,
          segmentCount: part.s3Keys.length,
        });

        // 更新分P状态为合并中
        await this.submissionRepository.updatePartStatus(
          submissionId,
          part.index,
          PartStatus.MERGING
        );

        // 1. 下载并合并分片
        const mergedFilePath = await this.downloadAndMergeSegments(
          part.s3Keys,
          tempDir,
          part.index
        );

        // 更新分P状态为上传中
        await this.submissionRepository.updatePartStatus(
          submissionId,
          part.index,
          PartStatus.UPLOADING
        );

        // 2. 上传到B站
        const videoPart: VideoPart = {
          title: `P${part.index}`,
          filename: path.basename(mergedFilePath),
          s3Key: '', // 本地文件，不需要 S3 key
          duration: 0,
          size: 0,
        };

        const filename = await this.uploadService.uploadPartFromLocal(
          mergedFilePath,
          videoPart
        );

        // 更新分P状态为完成
        await this.submissionRepository.updatePartStatus(
          submissionId,
          part.index,
          PartStatus.COMPLETED,
          { filename }
        );

        uploadedParts.push({
          title: `P${part.index}`,
          filename,
        });

        // 清理临时文件
        await fs.unlink(mergedFilePath).catch(() => {});

        this.logger.info('Part completed', {
          submissionId,
          partIndex: part.index,
          filename,
        });
      }

      // 3. 提交稿件
      await this.submissionRepository.updateStatus(
        submissionId,
        SubmissionStatus.SUBMITTING
      );

      const result = await this.uploadService.submitVideoParts(
        uploadedParts,
        {
          title: submission.title,
          description: submission.description,
          tags: submission.tags,
          tid: submission.tid,
          cover: submission.cover,
          copyright: submission.copyright,
          source: submission.source,
          dynamic: submission.dynamic,
        },
        submission.cover
      );

      // 更新投稿结果
      await this.submissionRepository.updateSubmissionResult(
        submissionId,
        result.bvid,
        result.avid
      );

      // 清理临时目录
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      this.logger.info('Submission completed', {
        submissionId,
        bvid: result.bvid,
        avid: result.avid,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error('Submission failed', {
        submissionId,
        error: errorMessage,
      });

      // 直接标记为失败
      await this.submissionRepository.updateStatus(
        submissionId,
        SubmissionStatus.FAILED,
        errorMessage
      );

      throw error;
    }
  }

  /**
   * 下载并合并分片
   */
  private async downloadAndMergeSegments(
    s3Keys: string[],
    tempDir: string,
    partIndex: number
  ): Promise<string> {
    const segmentFiles: string[] = [];

    // 下载所有分片
    for (let i = 0; i < s3Keys.length; i++) {
      const s3Key = s3Keys[i];
      const localPath = path.join(tempDir, `segment_${partIndex}_${i}.mkv`);

      this.logger.debug('Downloading segment', { s3Key, localPath });

      const buffer = await this.storageService.download(s3Key);
      await fs.writeFile(localPath, buffer);
      segmentFiles.push(localPath);
    }

    // 合并分片
    const outputPath = path.join(tempDir, `part_${partIndex}.mkv`);

    this.logger.info('Merging segments', {
      partIndex,
      segmentCount: segmentFiles.length,
      outputPath,
    });

    await this.mergeSegments(segmentFiles, outputPath);

    // 清理分片文件
    await Promise.all(segmentFiles.map(f => fs.unlink(f).catch(() => {})));

    return outputPath;
  }

  /**
   * 合并视频分片（使用 FFmpeg）
   */
  private async mergeSegments(
    segments: string[],
    outputPath: string
  ): Promise<{ duration: number; fileSize: number }> {
    const { spawn } = await import('child_process');

    // 创建文件列表
    const listFile = path.join(path.dirname(outputPath), 'segments.txt');
    const listContent = segments.map(s => `file '${s}'`).join('\n');
    await fs.writeFile(listFile, listContent);

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
        '-y',
        outputPath,
      ]);

      let stderr = '';
      ffmpeg.stderr?.on('data', data => {
        stderr += data.toString();
        this.logger.debug('FFmpeg merge output', { message: data.toString() });
      });

      ffmpeg.on('close', async code => {
        // 清理列表文件
        await fs.unlink(listFile).catch(() => {});

        if (code === 0) {
          const stats = await fs.stat(outputPath);
          // 获取视频时长
          const duration = await this.getVideoDuration(outputPath);
          resolve({ duration, fileSize: stats.size });
        } else {
          reject(new Error(`FFmpeg merge failed with code ${code}: ${stderr}`));
        }
      });

      ffmpeg.on('error', err => {
        reject(err);
      });
    });
  }

  /**
   * 获取视频时长
   */
  private async getVideoDuration(filePath: string): Promise<number> {
    const { spawn } = await import('child_process');

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
        reject(err);
      });
    });
  }

  /**
   * 获取投稿详情
   */
  async getSubmission(
    submissionId: string
  ): Promise<BilibiliSubmissionEntity | null> {
    return this.submissionRepository.findById(submissionId);
  }

  /**
   * 获取 Job 的投稿列表
   */
  async getSubmissionsByJobId(
    jobId: string
  ): Promise<BilibiliSubmissionEntity[]> {
    return this.submissionRepository.findByJobId(jobId);
  }

  /**
   * 获取投稿列表（分页）
   */
  async listSubmissions(options: {
    page?: number;
    pageSize?: number;
    jobId?: string;
    status?: SubmissionStatus;
  }): Promise<{ items: BilibiliSubmissionEntity[]; total: number }> {
    return this.submissionRepository.list(options);
  }

  /**
   * 从 streamer 获取最新投稿配置并更新 submission
   */
  private async updateSubmissionFromStreamer(
    submission: BilibiliSubmissionEntity
  ): Promise<void> {
    try {
      // 通过 jobId 获取 Job 信息
      const job = await this.jobService.findByJobId(submission.jobId);
      if (!job) {
        this.logger.warn('Job not found for submission', {
          submissionId: submission.id,
          jobId: submission.jobId,
        });
        return;
      }

      // 获取 streamer 信息
      const streamer = await this.streamerService.findByStreamerId(
        job.streamerId
      );
      if (!streamer?.uploadSettings) {
        this.logger.debug('No streamer upload settings found', {
          submissionId: submission.id,
          streamerId: job.streamerId,
        });
        return;
      }

      const { uploadSettings } = streamer;
      let updated = false;

      // 更新投稿信息（仅更新有值的字段）
      if (uploadSettings.title) {
        submission.title = uploadSettings.title;
        updated = true;
      }
      if (uploadSettings.description !== undefined) {
        submission.description = uploadSettings.description;
        updated = true;
      }
      if (uploadSettings.tags && uploadSettings.tags.length > 0) {
        submission.tags = uploadSettings.tags;
        updated = true;
      }
      if (uploadSettings.tid) {
        submission.tid = uploadSettings.tid;
        updated = true;
      }

      if (updated) {
        await this.submissionRepository.save(submission);
        this.logger.info('Updated submission from streamer settings', {
          submissionId: submission.id,
          streamerId: job.streamerId,
        });
      }
    } catch (error) {
      this.logger.error('Failed to update submission from streamer', {
        submissionId: submission.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // 不抛出错误，继续使用原有配置
    }
  }
}
