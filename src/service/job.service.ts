import { ILogger, Logger, Provide, Scope, ScopeEnum } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { nanoid } from 'nanoid';
import { In, LessThan, Repository } from 'typeorm';
import { Job, Streamer } from '../entity';
import { JOB_STATUS, JobStatus } from '../interface';
import dayjs = require('dayjs');

@Provide()
@Scope(ScopeEnum.Singleton)
export class JobService {
  @InjectEntityModel(Job)
  jobModel: Repository<Job>;

  @InjectEntityModel(Streamer)
  streamerModel: Repository<Streamer>;

  @Logger()
  private logger: ILogger;

  /**
   * 创建任务
   * 如果未提供 jobId，将自动使用 nanoid 生成 12 位随机字符串
   */
  async create(data: Partial<Job>): Promise<Job> {
    this.logger.debug('Creating job', { data });

    // 自动生成 jobId（如果未提供）
    const jobData = {
      ...data,
      jobId: data.jobId || this.generateJobId(),
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
    const job = await this.findById(id);
    if (job) {
      job.metadata = { ...job.metadata, ...metadata };
      await this.jobModel.save(job);
    }
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
    const job = await this.findById(id);
    if (job) {
      job.segmentCount += 1;
      if (duration) {
        job.duration = (job.duration || 0) + duration;
      }
      await this.jobModel.save(job);
    }
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
    const job = await this.findById(id);
    if (job) {
      const uploadedSegments = job.metadata?.uploadedSegments || [];
      if (!uploadedSegments.includes(s3Key)) {
        uploadedSegments.push(s3Key);
        await this.updateMetadata(id, { uploadedSegments });
      }
    }
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

    // 按日期分组
    const groups: Record<string, any[]> = {};

    for (const job of jobs) {
      // 片段数量筛选：如果设置了 minSegmentCount，则只保留片段数大于该值的任务
      if (minSegmentCount !== undefined && job.segmentCount <= minSegmentCount) {
        continue;
      }

      const dateKey = job.startTime
        ? dayjs(job.startTime).format('YYYY-MM-DD')
        : dayjs(job.createdAt).format('YYYY-MM-DD');

      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }

      // 构建展示数据
      const displayTitle = job.startTime
        ? `${dayjs(job.startTime).format('YYYY年M月D日 HH:mm')} ${
            job.streamerName
          } 直播回放`
        : `${job.streamerName} 直播回放`;

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

    // 构建视频列表
    const videos = uploadedSegments.map((s3Key: string, index: number) => {
      // 从 s3Key 解析文件名，格式如: jobs/{jobId}/video/segment_20240115_100000.mkv
      const filename = s3Key.split('/').pop() || `segment_${index}.mkv`;

      return {
        index,
        filename,
        s3Key,
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
}
