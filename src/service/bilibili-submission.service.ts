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
import {
  BilibiliUploadOptions,
  BilibiliUploadedPart,
  BilibiliUploadService,
  VideoPart,
} from './bilibili-upload.service';
import { StorageService } from './storage.service';
import { JobService } from './job.service';
import { SubmissionTemplateService } from './submission-template.service';
import { StreamerService } from './streamer.service';
import { buildPlatformRoomUrl } from '../utils/platform-room-url';
import { BilibiliCollectionBinding } from '../interface';
import { BilibiliSeasonService } from './bilibili-season.service';
import { BilibiliPartitionService } from './bilibili-partition.service';

/**
 * 每个分P的目标时长（1小时 = 3600秒）
 */
const PART_DURATION_SECONDS = 3600;

/**
 * 每个分片的时长（10秒）
 */
const SEGMENT_DURATION_SECONDS = 10;
const BILIBILI_COPYRIGHT_REPRINT = 2;
const REGENERATE_RESTORE_TIMEOUT_MS = 12000;

interface MergedPartFile {
  filePath: string;
  duration: number;
  fileSize: number;
}

/**
 * 创建投稿的输入参数
 */
export interface CreateSubmissionInput {
  jobId: string;
  parts?: SubmissionPart[];
  title?: string;
  description?: string;
  tags?: string[];
  humanType2?: number;
  cover?: string;
  copyright?: number;
  source?: string;
  dynamic?: string;
  collection?: BilibiliCollectionBinding;
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

  @Inject()
  private submissionTemplateService: SubmissionTemplateService;

  @Inject()
  private bilibiliSeasonService: BilibiliSeasonService;

  @Inject()
  private bilibiliPartitionService: BilibiliPartitionService;

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

    const streamer = await this.streamerService.findByStreamerId(
      job.streamerId
    );
    const streamerName = job.streamerName || streamer?.name;
    const uploadSettings = streamer?.uploadSettings || {};
    const title = this.submissionTemplateService.resolveTitle(
      input.title ?? uploadSettings.title,
      {
        streamerName,
        roomName: job.roomName,
        startedAt: job.startTime || job.createdAt,
      }
    );
    const description = input.description ?? uploadSettings.description ?? '';
    const tags = input.tags ?? uploadSettings.tags ?? [];
    const tid = this.submissionTemplateService.resolveTid(undefined);
    const humanType2 = this.bilibiliPartitionService.resolveHumanType2(
      input.humanType2 ?? uploadSettings.humanType2
    );
    const collection = this.resolveCollectionBinding(
      input.collection ?? uploadSettings.collection
    );
    const cover =
      input.cover ?? job.coverPath ?? streamer?.coverPath ?? undefined;
    const source =
      this.normalizeSource(input.source) ||
      buildPlatformRoomUrl(job.platform, job.roomId) ||
      buildPlatformRoomUrl(streamer?.platform, streamer?.roomId);

    // 规划分P结构
    const parts = input.parts
      ? this.normalizeSubmissionParts(input.parts)
      : this.planParts(s3Keys);

    this.logger.info('Creating submission', {
      jobId: input.jobId,
      totalSegments: s3Keys.length,
      totalParts: parts.length,
    });

    // 创建投稿记录
    const submission = await this.submissionRepository.create({
      jobId: input.jobId,
      title,
      description,
      tags,
      tid,
      humanType2,
      cover,
      copyright: BILIBILI_COPYRIGHT_REPRINT,
      source,
      dynamic: input.dynamic,
      collectionAutoAdd: collection.autoAdd,
      collectionSeasonId: collection.seasonId,
      collectionSectionId: collection.sectionId,
      collectionSeasonTitle: collection.seasonTitle,
      collectionSectionTitle: collection.sectionTitle,
      status: SubmissionStatus.PENDING,
      parts,
      totalParts: parts.length,
      completedParts: 0,
    });

    return submission;
  }

  /**
   * 规划分P结构
   * 将分片按照每1小时一个分P进行分组
   */
  private planParts(s3Keys: string[]): SubmissionPart[] {
    // 按 S3 key 排序（文件名包含时间戳）
    const sortedKeys = [...s3Keys].sort();

    // 计算每个分P包含的分片数（3600秒 / 10秒 = 360个分片）
    const segmentsPerPart = Math.floor(
      PART_DURATION_SECONDS / SEGMENT_DURATION_SECONDS
    );

    const parts: SubmissionPart[] = [];
    let currentPart: string[] = [];

    for (const key of sortedKeys) {
      currentPart.push(key);

      if (currentPart.length >= segmentsPerPart) {
        parts.push(
          this.buildSubmissionPart([...currentPart], parts.length + 1)
        );
        currentPart = [];
      }
    }

    // 处理剩余的分片
    if (currentPart.length > 0) {
      parts.push(this.buildSubmissionPart(currentPart, parts.length + 1));
    }

    return parts;
  }

  normalizeSubmissionParts(parts: SubmissionPart[]): SubmissionPart[] {
    return parts.map((part, index) =>
      this.buildSubmissionPart(
        part.s3Keys,
        index + 1,
        part.status,
        part.rhythmIntervalMinutes,
        part
      )
    );
  }

  buildSubmissionPart(
    s3Keys: string[],
    index: number,
    status: PartStatus = PartStatus.PENDING,
    rhythmIntervalMinutes?: number,
    data: Partial<SubmissionPart> = {}
  ): SubmissionPart {
    const sortedKeys = [...s3Keys].sort();
    const firstKey = sortedKeys[0];
    const lastKey = sortedKeys[sortedKeys.length - 1];
    const startedAt = this.parseSegmentDate(firstKey);
    const endedAt = this.parseSegmentDate(lastKey);

    return {
      ...data,
      index,
      title: data.title || this.formatPartTitleFromS3Key(firstKey),
      s3Keys: sortedKeys,
      status,
      rhythmIntervalMinutes,
      startedAt: data.startedAt || startedAt?.toISOString(),
      endedAt: data.endedAt || endedAt?.toISOString(),
      duration:
        data.duration ?? Math.round(sortedKeys.length * SEGMENT_DURATION_SECONDS * 1000),
    };
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

    this.logger.info('Processing submission', {
      submissionId,
      status: submission.status,
      totalParts: submission.totalParts,
      completedParts: submission.completedParts,
    });

    let tempDir: string | undefined;
    try {
      let result: { bvid: string; avid: number } = {
        bvid: submission.bvid || '',
        avid: Number(submission.avid || 0),
      };
      const parts = this.normalizeSubmissionParts(submission.parts || []);
      const uploadedParts: BilibiliUploadedPart[] = [];
      const hasUnfinishedParts = parts.some(
        part =>
          part.status !== PartStatus.COMPLETED || !part.filename || !part.cid
      );

      if (hasUnfinishedParts || !submission.avid || !submission.bvid) {
        await this.submissionRepository.updateStatus(
          submissionId,
          SubmissionStatus.UPLOADING
        );

        // 创建临时目录（使用项目根目录的 temp 文件夹）
        const projectRoot = path.resolve(__dirname, '..', '..');
        const tempBaseDir = path.join(projectRoot, 'temp', 'submissions');
        await fs.mkdir(tempBaseDir, { recursive: true });
        tempDir = await fs.mkdtemp(path.join(tempBaseDir, 'submission-'));

        for (const part of parts) {
          const partTitle = this.resolvePartTitle(part);

          // 跳过已完成的分P
          if (part.status === PartStatus.COMPLETED && part.filename && part.cid) {
            uploadedParts.push({
              title: partTitle,
              filename: part.filename,
              cid: part.cid,
            });
            if (part.title !== partTitle) {
              await this.submissionRepository.updatePartStatus(
                submissionId,
                part.index,
                PartStatus.COMPLETED,
                { title: partTitle }
              );
            }
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
            PartStatus.MERGING,
            { title: partTitle }
          );

          // 1. 下载并合并分片
          const mergedPart = await this.downloadAndMergeSegments(
            part.s3Keys,
            tempDir,
            part.index
          );
          const mergedFilePath = mergedPart.filePath;

          // 更新分P状态为上传中
          await this.submissionRepository.updatePartStatus(
            submissionId,
            part.index,
            PartStatus.UPLOADING,
            {
              duration: mergedPart.duration,
              size: mergedPart.fileSize,
            }
          );

          // 2. 上传到B站
          const videoPart: VideoPart = {
            title: partTitle,
            filename: path.basename(mergedFilePath),
            s3Key: '', // 本地文件，不需要 S3 key
            duration: mergedPart.duration,
            size: mergedPart.fileSize,
          };

          const uploadedPart = await this.uploadService.uploadPartFromLocal(
            mergedFilePath,
            videoPart
          );

          // 更新分P状态为完成
          await this.submissionRepository.updatePartStatus(
            submissionId,
            part.index,
            PartStatus.COMPLETED,
            {
              filename: uploadedPart.filename,
              cid: uploadedPart.cid,
              title: partTitle,
              duration: mergedPart.duration,
              size: mergedPart.fileSize,
            }
          );

          uploadedParts.push({
            title: partTitle,
            filename: uploadedPart.filename,
            cid: uploadedPart.cid,
          });

          // 清理临时文件
          await fs.unlink(mergedFilePath).catch(() => {});

          this.logger.info('Part completed', {
            submissionId,
            partIndex: part.index,
            filename: uploadedPart.filename,
            cid: uploadedPart.cid,
          });
        }

        // 3. 提交稿件
        await this.submissionRepository.updateStatus(
          submissionId,
          SubmissionStatus.SUBMITTING
        );

        const submitOptions = {
          title: submission.title,
          description: submission.description,
          tags: submission.tags,
          tid: submission.tid,
          humanType2: submission.humanType2,
          cover: submission.cover,
          copyright: submission.copyright,
          source: submission.source,
          dynamic: submission.dynamic,
        };

        if (submission.avid && submission.bvid) {
          const editResult = await this.uploadService.editVideoParts(
            Number(submission.avid),
            uploadedParts,
            submitOptions
          );
          result = {
            bvid: editResult.bvid || submission.bvid,
            avid: editResult.avid || Number(submission.avid),
          };
        } else {
          result = await this.uploadService.submitVideoParts(
            uploadedParts,
            submitOptions
          );
        }

        await this.submissionRepository.updateUploadedResult(
          submissionId,
          result.bvid,
          result.avid
        );
      } else {
        result = {
          bvid: submission.bvid,
          avid: Number(submission.avid),
        };
      }

      await this.submissionRepository.updateStatus(
        submissionId,
        SubmissionStatus.SUBMITTING
      );
      await this.addSubmissionToCollectionIfNeeded(
        submission,
        result.avid,
        uploadedParts[0]?.cid ||
          parts.find(part => Number(part.cid || 0) > 0)?.cid
      );
      await this.submissionRepository.completeSubmission(submissionId);

      // 清理临时目录
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }

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
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }

      throw error;
    }
  }

  async regenerateSubmission(
    submissionId: string
  ): Promise<BilibiliSubmissionEntity> {
    const submission = await this.submissionRepository.findById(submissionId);
    if (!submission) {
      throw new Error(`Submission not found: ${submissionId}`);
    }

    const editableUploadedParts = this.resolveReusableUploadedParts(submission);
    const uploadedParts = this.resolveReusableUploadedParts(submission, {
      omitCid: true,
    });
    const submitOptions = this.buildSubmitOptions(submission);

    await this.submissionRepository.updateStatus(
      submissionId,
      SubmissionStatus.SUBMITTING
    );

    try {
      const result =
        (await this.tryRestoreExistingArchive(
          submission,
          editableUploadedParts,
          submitOptions
        )) ||
        (await this.submitRegeneratedParts(
          uploadedParts,
          submitOptions,
          submission
        ));

      if (!result.bvid || !result.avid) {
        throw new Error('Bilibili returned success without archive id');
      }

      await this.submissionRepository.updateUploadedResult(
        submissionId,
        result.bvid,
        result.avid
      );
      await this.addSubmissionToCollectionIfNeeded(
        submission,
        result.avid,
        uploadedParts[0]?.cid
      );
      await this.submissionRepository.completeSubmission(submissionId);

      const updatedSubmission = await this.submissionRepository.findById(
        submissionId
      );
      if (!updatedSubmission) {
        throw new Error(`Submission not found after regenerate: ${submissionId}`);
      }

      this.logger.info('Bilibili submission regenerated', {
        submissionId,
        bvid: result.bvid,
        avid: result.avid,
      });

      return updatedSubmission;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.submissionRepository.updateStatus(
        submissionId,
        SubmissionStatus.FAILED,
        errorMessage
      );
      this.logger.error('Failed to regenerate bilibili submission', {
        submissionId,
        error: errorMessage,
      });
      throw error;
    }
  }

  private resolveCollectionBinding(collection?: BilibiliCollectionBinding): {
    autoAdd: boolean;
    seasonId: number | null;
    sectionId: number | null;
    seasonTitle: string | null;
    sectionTitle: string | null;
  } {
    const seasonId = Number(collection?.seasonId || 0);
    const sectionId = Number(collection?.sectionId || 0);
    const autoAdd = Boolean(
      collection?.autoAdd &&
        Number.isFinite(seasonId) &&
        seasonId > 0 &&
        Number.isFinite(sectionId) &&
        sectionId > 0
    );

    return {
      autoAdd,
      seasonId: autoAdd ? seasonId : null,
      sectionId: autoAdd ? sectionId : null,
      seasonTitle: autoAdd ? collection?.seasonTitle || null : null,
      sectionTitle: autoAdd ? collection?.sectionTitle || null : null,
    };
  }

  private async addSubmissionToCollectionIfNeeded(
    submission: BilibiliSubmissionEntity,
    avid: number,
    cid?: number
  ): Promise<void> {
    if (
      !submission.collectionAutoAdd ||
      !submission.collectionSectionId ||
      !submission.collectionSeasonId
    ) {
      return;
    }

    const collectionInput: {
      aid: number;
      sectionId: number;
      title: string;
      cid?: number;
    } = {
      aid: Number(avid),
      sectionId: Number(submission.collectionSectionId),
      title: submission.title,
    };
    const resolvedCid = Number(cid || 0);
    if (Number.isFinite(resolvedCid) && resolvedCid > 0) {
      collectionInput.cid = resolvedCid;
    }

    const collectionResult =
      await this.bilibiliSeasonService.addVideoToSeason(collectionInput);

    await this.submissionRepository.updateCollectionResult(
      submission.id,
      collectionResult.episodeId
    );

    this.logger.info('Submission added to bilibili collection', {
      submissionId: submission.id,
      aid: avid,
      seasonId: submission.collectionSeasonId,
      sectionId: submission.collectionSectionId,
      episodeId: collectionResult.episodeId,
      alreadyExists: collectionResult.alreadyExists,
    });
  }

  private buildSubmitOptions(
    submission: BilibiliSubmissionEntity
  ): BilibiliUploadOptions {
    return {
      title: submission.title,
      description: submission.description,
      tags: submission.tags,
      tid: submission.tid,
      humanType2: submission.humanType2,
      cover: submission.cover,
      copyright: submission.copyright,
      source: submission.source,
      dynamic: submission.dynamic,
    };
  }

  private async submitRegeneratedParts(
    uploadedParts: BilibiliUploadedPart[],
    submitOptions: BilibiliUploadOptions,
    submission: BilibiliSubmissionEntity
  ): Promise<{ bvid: string; avid: number }> {
    try {
      return await this.uploadService.submitVideoParts(
        uploadedParts,
        submitOptions
      );
    } catch (error) {
      if (!this.isDuplicateSuccessfulSubmissionError(error)) {
        throw error;
      }

      const recoveryTitle = this.buildRecoverySubmissionTitle(
        submission.title,
        submission.id
      );
      this.logger.warn(
        'Bilibili reported duplicate successful submission, retrying with recovery title',
        {
          submissionId: submission.id,
          originalTitle: submission.title,
          recoveryTitle,
          error: error instanceof Error ? error.message : String(error),
        }
      );

      let recoveryResult: { bvid: string; avid: number };
      try {
        recoveryResult = await this.uploadService.submitVideoParts(
          uploadedParts,
          {
            ...submitOptions,
            title: recoveryTitle,
          }
        );
      } catch (retryError) {
        if (this.isDuplicateSuccessfulSubmissionError(retryError)) {
          throw new Error(
            'B站已将这个上传文件绑定到已删除稿件，禁止通过投稿接口重复生成。已尝试编辑原稿件、filename-only 提交和临时标题提交，均被 B站拦截；需要重新上传源视频，或联系 B站客服恢复原稿件。'
          );
        }
        throw retryError;
      }

      try {
        const editResult = await this.uploadService.editVideoParts(
          recoveryResult.avid,
          uploadedParts,
          submitOptions
        );
        return {
          bvid: editResult.bvid || recoveryResult.bvid,
          avid: editResult.avid || recoveryResult.avid,
        };
      } catch (editError) {
        this.logger.warn(
          'Regenerated submission was created but original title restore failed',
          {
            submissionId: submission.id,
            bvid: recoveryResult.bvid,
            avid: recoveryResult.avid,
            recoveryTitle,
            error:
              editError instanceof Error
                ? editError.message
                : String(editError),
          }
        );
        return recoveryResult;
      }
    }
  }

  private async tryRestoreExistingArchive(
    submission: BilibiliSubmissionEntity,
    uploadedParts: BilibiliUploadedPart[],
    submitOptions: BilibiliUploadOptions
  ): Promise<{ bvid: string; avid: number } | null> {
    const avid = Number(submission.avid || 0);
    if (!Number.isFinite(avid) || avid <= 0) {
      return null;
    }

    try {
      this.logger.info('Trying to restore existing bilibili archive by edit', {
        submissionId: submission.id,
        avid,
        bvid: submission.bvid,
      });
      const result = await this.withTimeout(
        this.uploadService.editVideoParts(avid, uploadedParts, submitOptions),
        REGENERATE_RESTORE_TIMEOUT_MS,
        `Restore existing bilibili archive timed out after ${REGENERATE_RESTORE_TIMEOUT_MS}ms`
      );
      return {
        bvid: result.bvid || submission.bvid || '',
        avid: result.avid || avid,
      };
    } catch (error) {
      this.logger.warn('Failed to restore existing bilibili archive by edit', {
        submissionId: submission.id,
        avid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }) as Promise<T>;
  }

  private isDuplicateSuccessfulSubmissionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('稿件已成功投稿') &&
      message.includes('请勿重新提交')
    );
  }

  private buildRecoverySubmissionTitle(title: string, submissionId: string): string {
    const now = new Date();
    const suffix = ` 恢复${this.formatCompactDateTime(now)}${submissionId.slice(
      0,
      4
    )}`;
    const maxTitleLength = 80;
    if (title.length + suffix.length <= maxTitleLength) {
      return `${title}${suffix}`;
    }

    return `${title.slice(0, maxTitleLength - suffix.length)}${suffix}`;
  }

  private formatCompactDateTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(
      date.getHours()
    )}${pad(date.getMinutes())}`;
  }

  private resolveReusableUploadedParts(
    submission: BilibiliSubmissionEntity,
    options: {
      omitCid?: boolean;
    } = {}
  ): BilibiliUploadedPart[] {
    const parts = [...(submission.parts || [])].sort(
      (a, b) => Number(a.index || 0) - Number(b.index || 0)
    );
    if (parts.length === 0) {
      throw new Error('No reusable Bilibili uploaded parts found');
    }

    const missingPartIndexes: number[] = [];
    const uploadedParts = parts.map(part => {
      const filename = part.filename?.trim();
      const cid = Number(part.cid || 0);
      if (!filename || !Number.isFinite(cid) || cid <= 0) {
        missingPartIndexes.push(part.index);
      }

      return {
        title: this.resolvePartTitle(part),
        filename: filename || '',
        cid,
        omitCid: options.omitCid,
      };
    });

    if (missingPartIndexes.length > 0) {
      throw new Error(
        `Missing reusable Bilibili filename or CID for parts: ${missingPartIndexes
          .map(index => `P${index}`)
          .join(', ')}`
      );
    }

    return uploadedParts;
  }

  private normalizeSource(source?: string): string | undefined {
    const trimmed = source?.trim();
    return trimmed ? trimmed : undefined;
  }

  private resolvePartTitle(part: SubmissionPart): string {
    return part.title || this.formatPartTitleFromS3Key(part.s3Keys?.[0]);
  }

  private formatPartTitleFromS3Key(s3Key?: string): string {
    const dateParts = this.parseSegmentFilename(s3Key);
    if (!dateParts) {
      return this.formatPartTitle(new Date());
    }

    return `${dateParts.year}-${dateParts.month}-${dateParts.day} ${dateParts.hour}:${dateParts.minute}`;
  }

  private parseSegmentDate(s3Key?: string): Date | undefined {
    const dateParts = this.parseSegmentFilename(s3Key);
    if (!dateParts) {
      return undefined;
    }

    return new Date(
      Number(dateParts.year),
      Number(dateParts.month) - 1,
      Number(dateParts.day),
      Number(dateParts.hour),
      Number(dateParts.minute),
      Number(dateParts.second)
    );
  }

  private parseSegmentFilename(s3Key?: string):
    | {
        year: string;
        month: string;
        day: string;
        hour: string;
        minute: string;
        second: string;
      }
    | undefined {
    const basename = s3Key ? path.basename(s3Key) : '';
    const match = basename.match(/segment_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (!match) {
      return undefined;
    }

    const [, year, month, day, hour, minute, second] = match;
    return { year, month, day, hour, minute, second };
  }

  private formatPartTitle(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate()
    )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /**
   * 下载并合并分片
   */
  private async downloadAndMergeSegments(
    s3Keys: string[],
    tempDir: string,
    partIndex: number
  ): Promise<MergedPartFile> {
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

    const mergeResult = await this.mergeSegments(segmentFiles, outputPath);

    // 清理分片文件
    await Promise.all(segmentFiles.map(f => fs.unlink(f).catch(() => {})));

    return {
      filePath: outputPath,
      duration: mergeResult.duration,
      fileSize: mergeResult.fileSize,
    };
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
}
