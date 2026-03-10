export type Platform = 'bilibili' | 'huya' | 'douyu';

export interface StreamerInfo {
  id: string;
  streamerId: string;
  name: string;
  platform: Platform;
  roomId: string;
  isActive?: boolean;
  recordSettings?: {
    quality?: string;
    detectHighlights?: boolean;
  };
  uploadSettings?: {
    autoUpload?: boolean;
    title?: string;
    description?: string;
    tags?: string[];
    tid?: number;
  };
}

export interface StreamStatus {
  isLive: boolean;
  roomId: string;
  streamerId: string;
  title: string;
  viewerCount: number;
  startTime?: number;
}

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export enum JOB_STATUS {
  PENDING = 'pending',
  RECORDING = 'recording',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  STOPPING = 'stopping',
}

export interface JobMetadata {
  stream_url: string;
  danmaku_url: string;
  resolution?: string;
  bitrate?: number;
  codec?: string;
  highlights?: Highlight[];
  statistics?: {
    total_chats: number;
    total_gifts: number;
    unique_viewers: number;
  };
  totalSegments?: number; // 总分片数
  uploadedSegments?: string[]; // 已上传的 S3 key 列表
  lastFFmpegOutputTime?: number; // FFmpeg 最后输出时间（毫秒）
  recordedSegments?: number; // 已录制的分片数
  lastSegmentTime?: number; // 最后分片时间戳
}

export interface RecordParams {
  jobId: string;
  streamerId: string;
  streamerName: string;
  roomId: string;
  streamUrl: string;
  danmakuUrl: string;
  platform: Platform;
  title?: string;
  description?: string;
}

export interface RecordResult {
  jobId: string;
  videoPath: string; // S3 路径
  danmakuPath: string; // S3 路径
  segmentCount: number;
  duration: number;
  startTime: number;
  endTime: number;
}

export interface TranscodeParams {
  jobId: string;
  rawPath: string;
  outputPath: string;
}

export interface TranscodeResult {
  path: string;
  duration: number;
  fileSize: number;
}

export interface AnalysisParams {
  jobId: string;
  danmakuPath: string;
}

export interface Highlight {
  start: number;
  end: number;
  score: number;
  reason?: string;
}

export interface AnalysisResult {
  duration: number;
  totalScore: number;
  hasHighlights: boolean;
  highlights: Highlight[];
  metadata: {
    totalChats: number;
    totalGiftValue: number;
    uniqueViewers: number;
  };
}

export interface DanmakuMessage {
  timestamp: number;
  type: 'chat' | 'gift' | 'enter' | 'follow' | 'system';
  userId: string;
  username: string;
  content?: string;
  gift?: {
    name: string;
    count: number;
    value: number; // 价值(元)
  };
}

export interface TimeBucket {
  timestamp: number; // 桶起始时间
  chatCount: number; // 弹幕数量
  giftValue: number; // 礼物价值
  uniqueUsers: number; // 独立用户数
  score: number; // 综合热度分
}

export interface SegmentInfo {
  id: string; // 内部 UUID
  timestamp: number;
  type: 'video' | 'danmaku';
  localPath: string;
  s3Key: string;
  size: number;
  duration?: number; // 分片时长（毫秒）
}

export interface UploadActivityInput {
  jobId?: string;
  videoPath: string;
  title: string;
  description: string;
  platform: Platform;
  tags?: string[];
  tid?: number;
  videoType?: 'full' | 'highlight';
}

export interface UploadActivityOutput {
  bvid: string;
  avid: number;
  uploadedAt: number;
}

export interface PlatformAdapter {
  name: Platform;

  getStreamerStatus(streamerId: string): Promise<StreamStatus>;
  getStreamUrl(streamerId: string, quality?: string): Promise<string>;
  getDanmakuUrl(streamerId: string): Promise<string>;
  validateStreamerId(streamerId: string): Promise<boolean>;
}

export interface DanmakuCollector {
  connect(url: string, roomId: string): Promise<void>;
  disconnect(): Promise<void>;
  on(event: 'message', handler: (msg: DanmakuMessage) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'close', handler: () => void): void;
  isConnected(): boolean;
}

export interface TimeSync {
  calibrate(platform: PlatformAdapter): Promise<void>;

  /**
   * 将服务器时间戳转换为本地时间戳
   */
  toLocalTimestamp(serverTimestamp: number): number;

  /**
   * 获取当前对齐后的时间戳
   */
  now(): number;

  /**
   * 获取时间偏移量（毫秒）
   */
  getOffset(): number;
}

// ============ FFmpeg 录制器接口 ============

export interface RecorderOptions {
  id: string; // 内部 UUID，用于日志标识
  streamUrl: string;
  outputDir: string;
  segmentTime?: number; // seconds
  onSegmentComplete?: (segment: SegmentInfo) => void;
  onError?: (error: Error) => void;
}

export interface RecorderStatus {
  isRecording: boolean;
  segmentCount: number;
  duration: number;
  lastSegmentTime: number;
}

// ============ 心跳相关 ============

export interface HeartbeatData {
  recordedSegments: number;
  lastSegmentTime: number;
  status: 'recording' | 'paused' | 'stopped';
  timestamp: number;
}

// ============ 错误类型 ============

export class RecordingError extends Error {
  constructor(
    message: string,
    public code: string,
    public recoverable: boolean = false
  ) {
    super(message);
    this.name = 'RecordingError';
  }
}

export class PlatformError extends Error {
  constructor(message: string, public platform: Platform, public code: string) {
    super(message);
    this.name = 'PlatformError';
  }
}

export class StorageError extends Error {
  constructor(
    message: string,
    public operation: string,
    public retryable: boolean = true
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

// ============ 事件类型 ============

export const EventTypes = {
  // 弹幕事件
  DANMAKU_RECEIVED: 'danmaku:received',
  DANMAKU_BATCH: 'danmaku:batch',

  // 录制事件
  RECORDING_STARTED: 'recording:started',
  RECORDING_SEGMENT: 'recording:segment',
  RECORDING_STOPPED: 'recording:stopped',

  // 高光事件
  HIGHLIGHT_STARTED: 'highlight:started',
  HIGHLIGHT_ONGOING: 'highlight:ongoing',
  HIGHLIGHT_ENDED: 'highlight:ended',

  // 切片事件
  CLIP_STARTED: 'clip:started',
  CLIP_PROGRESS: 'clip:progress',
  CLIP_COMPLETED: 'clip:completed',
  CLIP_FAILED: 'clip:failed',

  // 上传事件
  UPLOAD_STARTED: 'upload:started',
  UPLOAD_PROGRESS: 'upload:progress',
  UPLOAD_COMPLETED: 'upload:completed',
  UPLOAD_FAILED: 'upload:failed',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

// ============ 事件载荷类型 ============

export interface DanmakuReceivedEvent {
  jobId: string;
  message: DanmakuMessage;
  relativeTime: number; // 相对于录制开始的时间（毫秒）
}

export interface RecordingStartedEvent {
  jobId: string;
  streamerId: string;
  platform: string;
  startTime: number;
}

export interface RecordingSegmentEvent {
  jobId: string;
  segment: SegmentInfo;
  segmentIndex: number;
}

export interface RecordingStoppedEvent {
  jobId: string;
  endTime: number;
  totalSegments: number;
  totalDanmaku: number;
}

export interface HighlightStartedEvent {
  jobId: string;
  highlightId: string;
  startTime: number; // 相对时间
  triggerDensity: number; // 触发时的弹幕密度
}

export interface HighlightEndedEvent {
  jobId: string;
  highlightId: string;
  highlight: Highlight;
  segments: string[]; // 涉及的 segment 文件路径
}

export interface ClipCompletedEvent {
  jobId: string;
  highlightId: string;
  outputPath: string;
  duration: number;
  fileSize: number;
}

// ============ BullMQ 任务数据类型 ============

export interface RecordingJobData {
  jobId: string; // Job 实体 ID
}

export interface TranscodeJobData {
  id: string; // 内部 UUID，用于数据库操作
  rawPath: string;
}

export interface AnalyzeJobData {
  id: string; // 内部 UUID，用于数据库操作
  danmakuPath: string;
}

export interface CleanupJobData {
  id: string; // 内部 UUID，用于数据库操作
  localPath: string; // 本地临时目录路径
}

export interface UploadJobData {
  id: string; // 内部 UUID
  s3Key: string; // S3 存储路径
  localPath: string; // 本地文件路径
  contentType: string; // 内容类型
}

// ============ B站投稿任务数据类型 ============

export interface BilibiliSubmissionJobData {
  submissionId: string; // 投稿记录 ID
}

// ============ 系统 Info 接口类型 ============

/** 主播开播状态信息 */
export interface StreamerLiveStatus {
  streamer: StreamerInfo;
  status: StreamStatus | null;
  error?: string;
}

/** 开播中的主播简略信息 */
export interface LiveStreamInfo {
  id: string;
  streamerId: string;
  name: string;
  platform: Platform;
  title: string;
  viewerCount: number;
  startTime?: number;
}

/** 未开播主播简略信息 */
export interface OfflineStreamerInfo {
  id: string;
  streamerId: string;
  name: string;
  platform: Platform;
}

/** 开播状态检查失败的主播信息 */
export interface FailedStreamerInfo {
  id: string;
  streamerId: string;
  name: string;
  platform: Platform;
  error: string;
}

// ============ B站凭证相关 ============

/** B站登录凭证 */
export interface BilibiliCredential {
  id?: string;
  accessToken: string;
  refreshToken: string;
  mid: number;
  expiresAt: Date;
  cookies: {
    SESSDATA: string;
    bili_jct: string;
    Dedeuserid: string;
  };
  createdAt?: Date;
  updatedAt?: Date;
}
