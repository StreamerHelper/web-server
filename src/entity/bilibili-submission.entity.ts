import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 投稿状态
 */
export enum SubmissionStatus {
  PENDING = 'pending', // 等待处理
  UPLOADING = 'uploading', // 上传中
  SUBMITTING = 'submitting', // 提交中
  COMPLETED = 'completed', // 已完成
  FAILED = 'failed', // 失败（超过重试次数）
}

/**
 * 分P状态
 */
export enum PartStatus {
  PENDING = 'pending', // 等待处理
  MERGING = 'merging', // 合并中
  UPLOADING = 'uploading', // 上传中
  COMPLETED = 'completed', // 已完成
  FAILED = 'failed', // 失败
}

/**
 * 分P信息（存储为JSONB）
 */
export interface SubmissionPart {
  /** 分P序号（从1开始） */
  index: number;
  /** 分P标题，固定使用日期+时间 */
  title?: string;
  /** 组成这个分P的原始分片S3 key */
  s3Keys: string[];
  /** 分P状态 */
  status: PartStatus;
  /** 分段投稿间隔，存在时表示该分P来自投稿节奏 */
  rhythmIntervalMinutes?: number;
  /** 分P起始时间 */
  startedAt?: string;
  /** 分P结束时间 */
  endedAt?: string;
  /** B站上传后的文件名 */
  filename?: string;
  /** B站上传后的分 P cid */
  cid?: number;
  /** 视频时长（毫秒） */
  duration?: number;
  /** 文件大小 */
  size?: number;
  /** 错误信息 */
  error?: string;
}

/**
 * B站投稿实体
 */
@Entity('bilibili_submissions')
export class BilibiliSubmissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'job_id' })
  @Index()
  jobId: string;

  // === 投稿信息 ===

  @Column({ name: 'title', length: 80 })
  title: string;

  @Column({ name: 'description', length: 2000, nullable: true })
  description: string;

  @Column({ name: 'tags', type: 'text', array: true, nullable: true })
  tags: string[];

  @Column({ name: 'tid', default: 171 })
  tid: number;

  @Column({ name: 'human_type2', default: 2066 })
  humanType2: number;

  @Column({ name: 'cover', nullable: true })
  cover: string;

  @Column({ name: 'copyright', default: 2 })
  copyright: number;

  @Column({ name: 'source', nullable: true })
  source: string;

  @Column({ name: 'dynamic', nullable: true })
  dynamic: string;

  // === 投稿状态 ===

  @Column({
    type: 'enum',
    enum: SubmissionStatus,
    default: SubmissionStatus.PENDING,
    name: 'status',
  })
  @Index()
  status: SubmissionStatus;

  // === 分P信息 ===

  @Column({ name: 'parts', type: 'jsonb' })
  parts: SubmissionPart[];

  @Column({ name: 'total_parts', default: 0 })
  totalParts: number;

  @Column({ name: 'completed_parts', default: 0 })
  completedParts: number;

  // === B站返回信息 ===

  @Column({ name: 'bvid', nullable: true })
  bvid: string;

  @Column({ name: 'avid', type: 'bigint', nullable: true })
  avid: number;

  // === B站合集信息 ===

  @Column({ name: 'collection_auto_add', default: false })
  collectionAutoAdd: boolean;

  @Column({ name: 'collection_season_id', type: 'bigint', nullable: true })
  collectionSeasonId: number;

  @Column({ name: 'collection_section_id', type: 'bigint', nullable: true })
  collectionSectionId: number;

  @Column({ name: 'collection_season_title', nullable: true, length: 255 })
  collectionSeasonTitle: string;

  @Column({ name: 'collection_section_title', nullable: true, length: 255 })
  collectionSectionTitle: string;

  @Column({ name: 'collection_episode_id', type: 'bigint', nullable: true })
  collectionEpisodeId: number;

  @Column({ name: 'collection_added_at', type: 'timestamptz', nullable: true })
  collectionAddedAt: Date;

  // === 错误信息 ===

  @Column({ name: 'last_error', nullable: true, length: 2000 })
  lastError: string;

  // === 时间戳 ===

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
