import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { nanoid } from 'nanoid';
import { In, LessThan, Repository } from 'typeorm';
import { Job, Streamer } from '../entity';
import {
  Highlight,
  JOB_STATUS,
  JobStatus,
  JobSubmissionSummary,
} from '../interface';
import { BilibiliSubmissionRepository } from '../repository/bilibili-submission.repository';
import { StorageService } from './storage.service';
import { SubmissionTemplateService } from './submission-template.service';
import dayjs = require('dayjs');

export interface JobStorageDeletionResult {
  jobId: string;
  deletedKeys: string[];
}

@Provide()
@Scope(ScopeEnum.Singleton)
export class JobService {
  private static readonly ARRAY_METADATA_FIELDS = new Set([
    'uploadedSegments',
    'failedVideoSegments',
    'uploadedDanmakuSegments',
    'failedDanmakuSegments',
    'highlights',
  ]);

  @InjectEntityModel(Job)
  jobModel: Repository<Job>;

  @InjectEntityModel(Streamer)
  streamerModel: Repository<Streamer>;

  @Inject()
  storageService: StorageService;

  @Inject()
  submissionTemplateService: SubmissionTemplateService;

  @Inject()
  bilibiliSubmissionRepository: BilibiliSubmissionRepository;

  @Logger()
  private logger: ILogger;

  /**
   * 创建任务
   * 如果未提供 jobId，将自动使用 nanoid 生成 12 位随机字符串
   */
  async create(data: Partial<Job>): Promise<Job> {
    this.logger.debug('Creating job', { data });

    let coverPath = data.coverPath;
    if (coverPath === undefined && data.streamerId) {
      const streamer = await this.streamerModel.findOne({
        where: { streamerId: data.streamerId },
      });
      coverPath = streamer?.coverPath ?? null;
    }

    // 自动生成 jobId（如果未提供）
    const jobData = {
      ...data,
      jobId: data.jobId || this.generateJobId(),
      coverPath: coverPath ?? null,
    };

    const job = this.jobModel.create(jobData);
    return await this.jobModel.save(job);
  }

  /**
   * 生成 jobId
   * 使用 nanoid 生成 12 位随机字符串
   */
  private generateJobId(): string {
    return nanoid(12);
  }

  /**
   * 根据 ID 查找任务
   */
  async findById(id: string): Promise<Job | null> {
    return await this.jobModel.findOne({ where: { id } });
  }

  /**
   * 根据 jobId 查找任务
   */
  async findByJobId(jobId: string): Promise<Job | null> {
    return await this.jobModel.findOne({ where: { jobId } });
  }

  /**
   * 根据主播和平台查找任务
   */
  async findByStreamers(
    streamerId: string,
    platform: string
  ): Promise<Job | null> {
    return await this.jobModel.findOne({
      where: { streamerId, platform },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * 查找所有任务（带分页）
   */
  async findAll(
    sortBy: 'createdAt' | 'updatedAt' | 'startTime' | 'endTime' = 'createdAt',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
    limit = 50,
    offset = 0
  ): Promise<{ jobs: Job[]; total: number }> {
    const [jobs, total] = await this.jobModel.findAndCount({
      order: { [sortBy]: sortOrder },
      take: limit,
      skip: offset,
    });
    return { jobs, total };
  }

  /**
   * 根据主播 ID 查找任务列表（带分页）
   */
  async findByStreamerId(
    streamerId: string,
    sortBy: 'createdAt' | 'updatedAt' | 'startTime' | 'endTime' = 'createdAt',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
    limit = 50,
    offset = 0
  ): Promise<{ jobs: Job[]; total: number }> {
    const [jobs, total] = await this.jobModel.findAndCount({
      where: { streamerId },
      order: { [sortBy]: sortOrder },
      take: limit,
      skip: offset,
    });
    return { jobs, total };
  }

  /**
   * 根据状态查找任务（带分页）
   */
  async findByStatus(
    status: JobStatus,
    sortBy: 'createdAt' | 'updatedAt' | 'startTime' | 'endTime' = 'createdAt',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
    limit = 50,
    offset = 0
  ): Promise<{ jobs: Job[]; total: number }> {
    const [jobs, total] = await this.jobModel.findAndCount({
      where: { status },
      order: { [sortBy]: sortOrder },
      take: limit,
      skip: offset,
    });
    return { jobs, total };
  }

  /**
   * 查找进行中的任务
   */
  async findActiveJobs(): Promise<Job[]> {
    return await this.jobModel.find({
      where: {
        status: In([JOB_STATUS.RECORDING, JOB_STATUS.STOPPING] as JobStatus[]),
      },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * 查找特定主播的活跃 Job（RECORDING/STOPPING/PROCESSING 状态）
   * @param streamerId 主播ID
   * @param platform 平台
   * @param heartbeatTimeoutMs 心跳超时时间（毫秒），默认 30 秒
   * @returns 活跃的 Job，如果不存在或已超时返回 null
   */
  async findActiveJobForStreamer(
    streamerId: string,
    platform: string,
    heartbeatTimeoutMs = 30000
  ): Promise<Job | null> {
    // 查找活跃状态的 Job
    const activeStatuses = [
      JOB_STATUS.RECORDING,
      JOB_STATUS.STOPPING,
      JOB_STATUS.PROCESSING,
    ] as JobStatus[];
    const job = await this.jobModel.findOne({
      where: { streamerId, platform, status: In(activeStatuses) },
      order: { createdAt: 'DESC' },
    });

    if (!job) {
      return null;
    }

    // 检查心跳（优先使用 metadata.lastFFmpegOutputTime，兜底使用 updatedAt）
    // updatedAt 会被其他数据库操作更新（如 addSegment），所以优先使用 lastFFmpegOutputTime
    const now = Date.now();
    const lastFFmpegOutputTime = job.metadata?.lastFFmpegOutputTime;

    // 如果没有 lastFFmpegOutputTime（Job 可能刚创建），使用 updatedAt 兜底
    const lastActiveTime = lastFFmpegOutputTime ?? job.updatedAt.getTime();
    const elapsed = now - lastActiveTime;

    if (elapsed > heartbeatTimeoutMs) {
      const recoveryStartedAt = job.metadata?.streamRecoveryLastAt
        ? Date.parse(job.metadata.streamRecoveryLastAt)
        : job.updatedAt.getTime();
      const recoveryElapsed = Number.isFinite(recoveryStartedAt)
        ? now - recoveryStartedAt
        : Number.POSITIVE_INFINITY;
      const nextRetryAt = job.metadata?.streamRecoveryNextRetryAt
        ? Date.parse(job.metadata.streamRecoveryNextRetryAt)
        : Number.NaN;
      const nextRetryGraceMs = Math.max(heartbeatTimeoutMs * 2, 60000);
      const isNearNextRetry =
        Number.isFinite(nextRetryAt) && now - nextRetryAt <= nextRetryGraceMs;
      const recoveryGraceMs = Math.max(heartbeatTimeoutMs * 10, 120000);

      if (
        job.metadata?.streamRecoveryInProgress &&
        (recoveryElapsed <= recoveryGraceMs || isNearNextRetry)
      ) {
        this.logger.warn(
          'Job heartbeat timeout while stream recovery is active',
          {
            jobId: job.jobId,
            streamerId,
            platform,
            elapsed,
            heartbeatTimeoutMs,
            recoveryElapsed,
            recoveryGraceMs,
            nextRetryAt: job.metadata.streamRecoveryNextRetryAt,
            nextRetryGraceMs,
            recoveryAttempt: job.metadata.streamRecoveryAttempt,
          }
        );
        return job;
      }

      // 检查异常崩溃导致的孤儿 Job，并更新其状态
      this.logger.warn('Job heartbeat timeout, marking as failed', {
        jobId: job.jobId,
        streamerId,
        platform,
        elapsed,
        heartbeatTimeoutMs,
      });
      await this.updateStatus(
        job.id,
        JOB_STATUS.FAILED,
        `Heartbeat timeout: ${elapsed}ms elapsed`
      );
      return null;
    }

    return job;
  }

  /**
   * 更新任务状态
   */
  async updateStatus(
    id: string,
    status: JobStatus,
    errorMessage?: string
  ): Promise<void> {
    const updateData: any = { status };
    if (errorMessage) {
      updateData.errorMessage = errorMessage;
    }
    if (status === JOB_STATUS.RECORDING && !updateData.startTime) {
      updateData.startTime = new Date();
    }
    if (
      status === JOB_STATUS.COMPLETED ||
      status === JOB_STATUS.FAILED ||
      status === JOB_STATUS.CANCELLED
    ) {
      updateData.endTime = new Date();
    }
    await this.jobModel.update({ id }, updateData);
  }

  /**
   * 更新任务元数据
   */
  async updateMetadata(
    id: string,
    metadata: Record<string, any>
  ): Promise<void> {
    if (Object.keys(metadata).length === 0) {
      return;
    }

    await this.jobModel.query(
      `
        UPDATE jobs
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
        WHERE id = $1
      `,
      [id, JSON.stringify(metadata)]
    );
  }

  /**
   * 更新视频路径
   */
  async updateVideoPath(id: string, videoPath: string): Promise<void> {
    await this.jobModel.update({ id }, { videoPath });
  }

  /**
   * 更新弹幕路径
   */
  async updateDanmakuPath(id: string, danmakuPath: string): Promise<void> {
    await this.jobModel.update({ id }, { danmakuPath });
  }

  /**
   * 增加片段计数和时长
   */
  async addSegment(id: string, duration?: number): Promise<void> {
    await this.jobModel.query(
      `
        UPDATE jobs
        SET segment_count = segment_count + 1,
            duration = COALESCE(duration, 0) + $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [id, duration || 0]
    );
  }

  /**
   * 更新任务时长
   */
  async updateDuration(id: string, duration: number): Promise<void> {
    await this.jobModel.update({ id }, { duration });
  }

  /**
   * 添加已上传分片到 metadata
   */
  async addUploadedSegment(id: string, s3Key: string): Promise<void> {
    await this.appendMetadataArrayValue(id, 'uploadedSegments', s3Key, true);
  }

  /**
   * 添加最终失败的视频分片到 metadata
   */
  async addFailedVideoSegment(id: string, s3Key: string): Promise<void> {
    await this.appendMetadataArrayValue(id, 'failedVideoSegments', s3Key, true);
  }

  /**
   * 添加已上传弹幕分片到 metadata
   */
  async addUploadedDanmakuSegment(id: string, s3Key: string): Promise<void> {
    await this.appendMetadataArrayValue(
      id,
      'uploadedDanmakuSegments',
      s3Key,
      true
    );
  }

  /**
   * 添加最终失败的弹幕分片到 metadata
   */
  async addFailedDanmakuSegment(id: string, s3Key: string): Promise<void> {
    await this.appendMetadataArrayValue(
      id,
      'failedDanmakuSegments',
      s3Key,
      true
    );
  }

  /**
   * 追加高光到 metadata
   */
  async addHighlight(id: string, highlight: Highlight): Promise<void> {
    await this.appendMetadataArrayValue(id, 'highlights', highlight, false);
  }

  /**
   * 取消任务
   */
  async cancel(id: string): Promise<void> {
    await this.jobModel.update(
      { id },
      { status: JOB_STATUS.CANCELLED, endTime: new Date() }
    );
  }

  async attachSubmissionSummaries<T extends Job>(
    jobs: T[]
  ): Promise<Array<T & { submissions: JobSubmissionSummary[] }>> {
    if (jobs.length === 0) {
      return [];
    }

    const jobIds = Array.from(
      new Set(jobs.map(job => job.jobId).filter(Boolean))
    );
    const submissions = this.bilibiliSubmissionRepository?.findByJobIds
      ? await this.bilibiliSubmissionRepository.findByJobIds(jobIds)
      : [];
    const submissionsByJobId = new Map<string, JobSubmissionSummary[]>();

    for (const submission of submissions) {
      const summary: JobSubmissionSummary = {
        id: submission.id,
        jobId: submission.jobId,
        title: submission.title,
        status: submission.status,
        bvid: submission.bvid,
        avid: submission.avid,
        totalParts: submission.totalParts,
        completedParts: submission.completedParts,
        lastError: submission.lastError,
        createdAt: submission.createdAt,
        updatedAt: submission.updatedAt,
      };

      const items = submissionsByJobId.get(submission.jobId) || [];
      items.push(summary);
      submissionsByJobId.set(submission.jobId, items);
    }

    return jobs.map(job =>
      Object.assign(job, {
        submissions: submissionsByJobId.get(job.jobId) || [],
      })
    );
  }

  async attachSubmissionSummary<T extends Job>(
    job: T | null
  ): Promise<(T & { submissions: JobSubmissionSummary[] }) | null> {
    if (!job) {
      return null;
    }

    const [result] = await this.attachSubmissionSummaries([job]);
    return result;
  }

  async deleteJobStorage(
    id: string,
    reason: 'manual' | 'scheduled' = 'manual'
  ): Promise<JobStorageDeletionResult> {
    const job = await this.findById(id);
    if (!job) {
      throw new Error('Job not found');
    }

    const keys = await this.collectJobStorageKeys(job);
    const deletedKeys: string[] = [];

    for (let i = 0; i < keys.length; i += 50) {
      const batch = keys.slice(i, i + 50);
      await this.storageService.deleteMultiple(batch);
      deletedKeys.push(...batch);
    }

    await this.jobModel.update({ id }, {
      videoPath: null,
      danmakuPath: null,
    } as any);
    await this.updateMetadata(id, {
      storageDeleted: true,
      storageDeletedAt: new Date().toISOString(),
      storageDeletedKeys: deletedKeys,
      storageDeleteReason: reason,
    });

    this.logger.info('Job storage deleted', {
      id,
      jobId: job.jobId,
      reason,
      deletedKeys: deletedKeys.length,
    });

    return {
      jobId: job.jobId,
      deletedKeys,
    };
  }

  private async appendMetadataArrayValue(
    id: string,
    field: string,
    value: unknown,
    unique: boolean
  ): Promise<void> {
    if (!JobService.ARRAY_METADATA_FIELDS.has(field)) {
      throw new Error(`Unsupported metadata array field: ${field}`);
    }

    await this.jobModel.query(
      `
        UPDATE jobs
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{${field}}',
              CASE
                WHEN $3::boolean
                  AND COALESCE(metadata->'${field}', '[]'::jsonb) @> jsonb_build_array($2::jsonb)
                THEN COALESCE(metadata->'${field}', '[]'::jsonb)
                ELSE COALESCE(metadata->'${field}', '[]'::jsonb) || jsonb_build_array($2::jsonb)
              END,
              true
            ),
            updated_at = NOW()
        WHERE id = $1
      `,
      [id, JSON.stringify(value), unique]
    );
  }

  /**
   * 获取任务统计
   */
  async getStats(): Promise<{
    total: number;
    pending: number;
    recording: number;
    processing: number;
    completed: number;
    failed: number;
  }> {
    const [total, pending, recording, processing, completed, failed] =
      await Promise.all([
        this.jobModel.count(),
        this.jobModel.count({ where: { status: JOB_STATUS.PENDING } }),
        this.jobModel.count({ where: { status: JOB_STATUS.RECORDING } }),
        this.jobModel.count({ where: { status: JOB_STATUS.PROCESSING } }),
        this.jobModel.count({ where: { status: JOB_STATUS.COMPLETED } }),
        this.jobModel.count({ where: { status: JOB_STATUS.FAILED } }),
      ]);

    return { total, pending, recording, processing, completed, failed };
  }

  /**
   * 清理旧任务
   */
  async cleanupOldJobs(days = 30): Promise<number> {
    const cutoffDate = dayjs().subtract(days, 'day').toDate();

    const result = await this.jobModel.delete({
      createdAt: LessThan(cutoffDate),
      status: In([
        JOB_STATUS.COMPLETED,
        JOB_STATUS.FAILED,
        JOB_STATUS.CANCELLED,
      ] as JobStatus[]),
    });

    return result.affected || 0;
  }

  /**
   * 获取所有任务，按日期分组（用于内容浏览）
   * @param streamerName 主播名称筛选（可选）
   * @param startDate 开始日期筛选（可选，格式 YYYY-MM-DD）
   * @param endDate 结束日期筛选（可选，格式 YYYY-MM-DD）
   * @param minSegmentCount 最小片段数量筛选（可选）
   */
  async findAllGroupedByDate(
    streamerName?: string,
    startDate?: string,
    endDate?: string,
    minSegmentCount?: number
  ): Promise<Record<string, any[]>> {
    // 构建查询条件
    const queryBuilder = this.jobModel.createQueryBuilder('job');

    if (streamerName) {
      queryBuilder.andWhere('job.streamerName = :streamerName', {
        streamerName,
      });
    }

    if (startDate) {
      const start = dayjs(startDate).startOf('day').toDate();
      queryBuilder.andWhere('job.startTime >= :startDate', {
        startDate: start,
      });
    }

    if (endDate) {
      const end = dayjs(endDate).endOf('day').toDate();
      queryBuilder.andWhere('job.startTime <= :endDate', { endDate: end });
    }

    queryBuilder.orderBy('job.startTime', 'DESC');

    const jobs = await queryBuilder.getMany();
    const streamerById = await this.findStreamerMapForJobs(jobs);

    // 按日期分组
    const groups: Record<string, any[]> = {};

    for (const job of jobs) {
      if (job.metadata?.storageDeleted) {
        continue;
      }

      // 片段数量筛选：如果设置了 minSegmentCount，则只保留片段数大于等于该值的任务
      if (minSegmentCount !== undefined && job.segmentCount < minSegmentCount) {
        continue;
      }

      const dateKey = job.startTime
        ? dayjs(job.startTime).format('YYYY-MM-DD')
        : dayjs(job.createdAt).format('YYYY-MM-DD');

      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }

      const streamer = streamerById.get(job.streamerId);
      const displayTitle = this.resolveSubmissionTitle(job, streamer);

      groups[dateKey].push({
        id: job.id,
        jobId: job.jobId,
        title: displayTitle,
        streamerName: job.streamerName,
        roomName: job.roomName,
        platform: job.platform,
        status: job.status,
        duration: job.duration,
        segmentCount: job.segmentCount,
        startTime: job.startTime,
        endTime: job.endTime,
        coverUrl: await this.getSafeCoverUrl(job.id, job.coverPath),
      });
    }

    return groups;
  }

  /**
   * 获取所有有录制任务的主播名称列表（用于筛选下拉框）
   */
  async getStreamerNames(): Promise<string[]> {
    const result = await this.jobModel
      .createQueryBuilder('job')
      .select('DISTINCT job.streamerName', 'streamerName')
      .orderBy('job.streamerName', 'ASC')
      .getRawMany();

    return result.map(r => r.streamerName);
  }

  private async findStreamerMapForJobs(
    jobs: Job[]
  ): Promise<Map<string, Streamer>> {
    const streamerIds = Array.from(
      new Set(jobs.map(job => job.streamerId).filter(Boolean))
    );

    if (streamerIds.length === 0) {
      return new Map();
    }

    const streamers = await this.streamerModel.find({
      where: { streamerId: In(streamerIds) },
    });

    return new Map(streamers.map(streamer => [streamer.streamerId, streamer]));
  }

  private resolveSubmissionTitle(job: Job, streamer?: Streamer): string {
    return this.submissionTemplateService.resolveTitle(
      streamer?.uploadSettings?.title,
      {
        streamerName: job.streamerName || streamer?.name,
        roomName: job.roomName,
        startedAt: job.startTime || job.createdAt,
      }
    );
  }

  private async getSafeCoverUrl(
    jobId: string,
    coverPath?: string | null
  ): Promise<string | null> {
    if (!jobId || !coverPath) {
      return null;
    }

    return `/api/jobs/${jobId}/cover`;
  }

  private async collectJobStorageKeys(job: Job): Promise<string[]> {
    const keys = new Set<string>();

    for (const key of [job.videoPath, job.danmakuPath, job.coverPath]) {
      this.addDeletableStorageKey(keys, key, job);
    }

    this.collectMetadataStorageKeys(keys, job.metadata, job);

    for (const prefix of this.getJobStoragePrefixes(job)) {
      const listedKeys = await this.storageService.list(prefix);
      for (const key of listedKeys) {
        this.addDeletableStorageKey(keys, key, job);
      }
    }

    return Array.from(keys).sort();
  }

  private collectMetadataStorageKeys(
    keys: Set<string>,
    value: unknown,
    job: Job
  ): void {
    if (typeof value === 'string') {
      this.addDeletableStorageKey(keys, value, job);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectMetadataStorageKeys(keys, item, job);
      }
      return;
    }

    if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) {
        this.collectMetadataStorageKeys(keys, item, job);
      }
    }
  }

  private addDeletableStorageKey(
    keys: Set<string>,
    value: unknown,
    job: Job
  ): void {
    if (typeof value !== 'string') {
      return;
    }

    const key = value.trim();
    if (!key || !this.isJobStorageKey(key, job)) {
      return;
    }

    keys.add(key);
  }

  private isJobStorageKey(key: string, job: Job): boolean {
    if (
      key.startsWith('/') ||
      key.includes('..') ||
      /^(https?:|wss?:|data:|\/\/)/i.test(key)
    ) {
      return false;
    }

    return this.getJobStoragePrefixes(job).some(prefix =>
      key.startsWith(prefix)
    );
  }

  private getJobStoragePrefixes(job: Job): string[] {
    const identifiers = Array.from(
      new Set([job.id, job.jobId].filter(Boolean))
    );
    return identifiers.flatMap(identifier => [
      `raw/${identifier}/`,
      `danmaku/${identifier}/`,
      `transcript/${identifier}/`,
      `processed/${identifier}/`,
      `merged/${identifier}/`,
      `jobs/${identifier}/`,
    ]);
  }

  /**
   * 获取任务的视频列表
   */
  async getJobVideos(id: string): Promise<any> {
    const job = await this.findById(id);
    if (!job) {
      return null;
    }

    // 从 metadata 获取视频分片信息
    const uploadedSegments = job.metadata?.uploadedSegments || [];

    const rawVideos = uploadedSegments.map((s3Key: string, index: number) => {
      const filename = s3Key.split('/').pop() || `segment_${index}.mkv`;
      const timestamp = this.parseVideoSegmentTimestamp(filename);

      return {
        index,
        filename,
        s3Key,
        timestamp,
      };
    });

    const firstTimestamp =
      rawVideos.find(video => video.timestamp !== null)?.timestamp ?? null;
    const defaultSegmentDuration =
      rawVideos.length > 0
        ? Math.max(Math.round(job.duration / rawVideos.length), 10_000)
        : 10_000;

    const videos = rawVideos.map((video, index) => {
      const fallbackStartOffsetMs = index * defaultSegmentDuration;
      const startOffsetMs =
        video.timestamp !== null && firstTimestamp !== null
          ? Math.max(0, video.timestamp - firstTimestamp)
          : fallbackStartOffsetMs;

      const nextVideo = rawVideos[index + 1];
      const derivedEndOffsetMs =
        nextVideo?.timestamp != null && firstTimestamp !== null
          ? Math.max(startOffsetMs + 1000, nextVideo.timestamp - firstTimestamp)
          : startOffsetMs + defaultSegmentDuration;
      const endOffsetMs =
        index === rawVideos.length - 1
          ? Math.max(startOffsetMs + 1000, job.duration || derivedEndOffsetMs)
          : derivedEndOffsetMs;

      return {
        index: video.index,
        filename: video.filename,
        s3Key: video.s3Key,
        startOffsetMs,
        endOffsetMs,
        durationMs: Math.max(1000, endOffsetMs - startOffsetMs),
        // 播放地址（需要前端通过这个地址请求视频流）
        url: `/api/jobs/${id}/videos/${index}/stream`,
      };
    });

    return {
      jobId: job.id,
      streamerName: job.streamerName,
      roomName: job.roomName,
      platform: job.platform,
      duration: job.duration,
      segmentCount: job.segmentCount,
      videos,
    };
  }

  /**
   * 合并视频分片
   * @param id 任务 ID
   * @param segmentIndexes 要合并的分片索引数组
   * @returns 合并后的视频信息
   */
  async mergeVideos(
    id: string,
    segmentIndexes: number[]
  ): Promise<{
    s3Key: string;
    filename: string;
    duration: number;
    size: number;
  }> {
    const job = await this.findById(id);
    if (!job) {
      throw new Error('Job not found');
    }

    const uploadedSegments = job.metadata?.uploadedSegments || [];
    if (uploadedSegments.length === 0) {
      throw new Error('No video segments found');
    }

    // 验证分片索引
    for (const idx of segmentIndexes) {
      if (idx < 0 || idx >= uploadedSegments.length) {
        throw new Error(`Invalid segment index: ${idx}`);
      }
    }

    // 按 index 排序，确保合并顺序正确
    const sortedIndexes = [...segmentIndexes].sort((a, b) => a - b);

    // 获取要合并的分片 s3Key
    const segmentsToMerge = sortedIndexes.map(idx => uploadedSegments[idx]);

    return {
      s3Key: '', // 由调用方填充
      filename: '', // 由调用方填充
      segments: segmentsToMerge, // 临时传递
      duration: 0,
      size: 0,
    } as any;
  }

  private parseVideoSegmentTimestamp(filename: string): number | null {
    const match = filename.match(/segment_(\d{8})_(\d{6})\.mkv$/);
    if (!match) {
      return null;
    }

    const [, date, time] = match;
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6)) - 1;
    const day = Number(date.slice(6, 8));
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(2, 4));
    const second = Number(time.slice(4, 6));

    return Date.UTC(year, month, day, hour, minute, second);
  }
}
