// ============ 弹幕和转录文本数据结构 ============

/**
 * 弹幕类型
 */
export enum DanmakuType {
  CHAT = 'chat', // 普通聊天
  GIFT = 'gift', // 礼物
  SUPER_CHAT = 'sc', // 醒目留言/SC
  ENTER = 'enter', // 进入房间
  FOLLOW = 'follow', // 关注
  SHARE = 'share', // 分享直播
  LIKE = 'like', // 点赞
  INTERACT = 'interact', // 互动（点赞、评论等）
  NOTICE = 'notice', // 系统通知
  UNKNOWN = 'unknown', // 未知类型
}

/**
 * 弹幕颜色（B站标准）
 */
export enum DanmakuColor {
  WHITE = 0xffffff,
  RED = 0xff0000,
  ORANGE = 0xffa500,
  YELLOW = 0xffff00,
  GREEN = 0x00ff00,
  CYAN = 0x00ffff,
  BLUE = 0x0000ff,
  PURPLE = 0x800080,
  BLACK = 0x000000,
}

/**
 * 弹幕位置类型
 */
export enum DanmakuPosition {
  SCROLL = 0, // 滚动弹幕
  BOTTOM = 1, // 底部弹幕
  TOP = 2, // 顶部弹幕
  REVERSE = 3, // 逆向滚动弹幕（特殊）
  POSITION = 4, // 位置弹幕（特殊）
}

/**
 * 弹幕消息（单条）
 */
export interface DanmakuMessage {
  // 基本信息
  id: string; // 唯一 ID
  timestamp: number; // 时间戳（毫秒，相对于录制开始）
  type: DanmakuType; // 弹幕类型

  // 用户信息
  userId: string; // 用户 ID
  username: string; // 用户名
  userAvatar?: string; // 用户头像 URL
  isAdmin?: boolean; // 是否房管
  isVip?: boolean; // 是否 VIP
  isMobile?: boolean; // 是否移动端

  // 内容信息
  content?: string; // 弹幕内容（聊天弹幕）
  contentColor?: number; // 内容颜色
  fontSize?: number; // 字体大小

  // 弹幕样式（仅普通弹幕）
  position?: DanmakuPosition; // 弹幕位置
  color?: DanmakuColor; // 弹幕颜色
  // 特殊弹幕的位置和运动参数
  posX?: number; // X 坐标（0-1000）
  posY?: number; // Y 坐标（0-1000）
  moveX?: number; // X 方向移动速度
  moveY?: number; // Y 方向移动速度
  duration?: number; // 显示时长（毫秒）

  // 礼物信息
  gift?: {
    giftId: string; // 礼物 ID
    giftName: string; // 礼物名称
    count: number; // 礼物数量
    price: number; // 礼物单价（元）
    totalPrice: number; // 礼物总价（元）
    effectUrl?: string; // 礼物特效 URL
  };

  // SC 信息
  superChat?: {
    price: number; // SC 价格（元）
    backgroundColor: string; // 背景色
    borderColor: string; // 边框色
    backgroundIconUrl?: string; // 背景图标
  };

  // 原始数据（用于调试）
  raw?: any; // 原始平台数据
}

/**
 * 弹幕分片信息
 */
export interface DanmakuSegmentInfo {
  segmentId: string; // 分片 ID（与视频分片对应）
  jobId: string; // 关联的 Job ID
  startTime: number; // 分片开始时间（毫秒，相对录制开始）
  endTime: number; // 分片结束时间（毫秒）
  messageCount: number; // 消息数量
  types: { [key in DanmakuType]?: number }; // 各类型消息数量
  s3Key: string; // S3 存储路径
  size: number; // 文件大小（字节）
  createdAt: number; // 创建时间
}

/**
 * 弹幕索引（完整录制）
 */
export interface DanmakuIndex {
  jobId: string; // Job ID
  streamerId: string; // 主播 ID
  platform: string; // 平台
  roomId: string; // 房间号

  // 时间范围
  startTime: number; // 录制开始时间
  endTime: number; // 录制结束时间
  duration: number; // 总时长（毫秒）

  // 统计信息
  totalMessages: number; // 总消息数
  uniqueUsers: number; // 独立用户数
  types: { [key in DanmakuType]?: number }; // 各类型消息数量

  // 分片信息
  segments: DanmakuSegmentInfo[];

  // 导出文件
  files: {
    xml?: string; // XML 文件 S3 路径
    json?: string; // JSON 文件 S3 路径
    ass?: string; // ASS 文件 S3 路径
  };
}

// ============ 转录文本数据结构 ============

/**
 * 转录文本类型
 */
export enum TranscriptType {
  INTERIM = 'interim', // 临时结果（流式识别过程中）
  FINAL = 'final', // 最终结果
  PUNCTUATED = 'punctuated', // 带标点符号
}

/**
 * 说话人（预留，用于说话人分离）
 */
export interface Speaker {
  id: string; // 说话人 ID
  name: string; // 说话人名称
  confidence?: number; // 识别置信度
  avatar?: string; // 头像 URL
}

/**
 * 单个转录词
 */
export interface TranscriptWord {
  word: string; // 词
  startTime: number; // 开始时间（毫秒）
  endTime: number; // 结束时间（毫秒）
  confidence: number; // 置信度 (0-1)
}

/**
 * 单条转录结果
 */
export interface TranscriptMessage {
  id: string; // 唯一 ID
  timestamp: number; // 时间戳（毫秒，相对于录制开始）
  type: TranscriptType; // 转录类型

  // 文本内容
  text: string; // 识别文本
  words?: TranscriptWord[]; // 分词信息（可选，用于精确时间戳）

  // 说话人信息（预留）
  speaker?: Speaker;

  // 置信度
  confidence: number; // 整体置信度 (0-1)

  // 语言
  language: string; // 语言代码（zh-CN, en-US 等）

  // 原始数据
  raw?: any; // 原始 ASR 返回数据
}

/**
 * 转录分片信息
 */
export interface TranscriptSegmentInfo {
  segmentId: string; // 分片 ID（与视频分片对应）
  jobId: string; // 关联的 Job ID
  startTime: number; // 分片开始时间（毫秒）
  endTime: number; // 分片结束时间（毫秒）
  messageCount: number; // 消息数量
  wordCount?: number; // 总词数
  s3Key: string; // S3 存储路径
  size: number; // 文件大小（字节）
  duration: number; // 有效语音时长（毫秒）
  createdAt: number; // 创建时间
}

/**
 * 转录索引（完整录制）
 */
export interface TranscriptIndex {
  jobId: string; // Job ID
  streamerId: string; // 主播 ID
  platform: string; // 平台
  roomId: string; // 房间号

  // 时间范围
  startTime: number; // 录制开始时间
  endTime: number; // 录制结束时间
  duration: number; // 总时长（毫秒）
  audioDuration: number; // 有效语音时长（毫秒）

  // 统计信息
  totalMessages: number; // 总消息数
  totalWords: number; // 总词数
  uniqueSpeakers?: number; // 独立说话人数（如果启用说话人分离）

  // 语言分布
  languages: { [lang: string]: number }; // 各语言占比

  // 分片信息
  segments: TranscriptSegmentInfo[];

  // 导出文件
  files: {
    text?: string; // 纯文本文件 S3 路径
    srt?: string; // SRT 字幕文件 S3 路径
    vtt?: string; // VTT 字幕文件 S3 路径
    json?: string; // JSON 文件 S3 路径
  };
}

// ============ Job 扩展 ============

/**
 * Job 数据扩展
 */
export interface JobMetadataExtended {
  // 原有字段
  stream_url: string;
  danmaku_url: string;
  resolution?: string;
  bitrate?: number;
  codec?: string;
  highlights?: any[];
  statistics?: {
    total_chats: number;
    total_gifts: number;
    unique_viewers: number;
  };
  totalSegments?: number;
  uploadedSegments?: string[];

  // 新增字段
  danmakuIndex?: DanmakuIndex; // 弹幕索引
  transcriptIndex?: TranscriptIndex; // 转录文本索引
}

// ============ BullMQ 任务数据 ============

export interface DanmakuUploadJobData {
  id: string; // Job ID
  segmentId: string; // 分片 ID
  s3Key: string; // S3 存储路径
  localPath: string; // 本地文件路径
  index: DanmakuIndex; // 弹幕索引（用于更新）
}

export interface TranscriptJobData {
  id: string; // Job ID
  segmentId: string; // 分片 ID
  videoS3Key: string; // 视频分片 S3 路径
  outputS3Key: string; // 输出 S3 路径
}

export interface TranscriptUploadJobData {
  id: string; // Job ID
  segmentId: string; // 分片 ID
  s3Key: string; // S3 存储路径
  localPath: string; // 本地文件路径
  index: TranscriptIndex; // 转录索引（用于更新）
}

// ============ API 请求/响应类型 ============

/**
 * 查询弹幕请求
 */
export interface QueryDanmakuRequest {
  jobId: string; // Job ID
  startTime?: number; // 开始时间（毫秒）
  endTime?: number; // 结束时间（毫秒）
  types?: DanmakuType[]; // 弹幕类型筛选
  userId?: string; // 用户 ID 筛选
  keyword?: string; // 关键词搜索
  limit?: number; // 返回数量限制
  offset?: number; // 偏移量
}

/**
 * 查询弹幕响应
 */
export interface QueryDanmakuResponse {
  messages: DanmakuMessage[];
  total: number;
  hasMore: boolean;
}

/**
 * 查询转录文本请求
 */
export interface QueryTranscriptRequest {
  jobId: string; // Job ID
  startTime?: number; // 开始时间（毫秒）
  endTime?: number; // 结束时间（毫秒）
  speakerId?: string; // 说话人筛选
  keyword?: string; // 关键词搜索
  limit?: number;
  offset?: number;
}

/**
 * 查询转录文本响应
 */
export interface QueryTranscriptResponse {
  messages: TranscriptMessage[];
  total: number;
  hasMore: boolean;
}

/**
 * 导出请求
 */
export interface ExportRequest {
  jobId: string;
  type: 'danmaku' | 'transcript';
  format: 'xml' | 'json' | 'ass' | 'txt' | 'srt' | 'vtt';
}

/**
 * 导出响应
 */
export interface ExportResponse {
  downloadUrl: string; // 预签名下载 URL
  expiresAt: number; // 过期时间
}
