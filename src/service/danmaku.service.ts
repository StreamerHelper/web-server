import {
  App,
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { Application } from '@midwayjs/koa';
import { EventEmitter } from 'events';
import * as WebSocket from 'ws';
import { DanmakuMessage } from '../interface/data';
import { DanmakuXmlMetadata, DanmakuXmlService } from './danmaku-xml.service';
const { WebSocket: WS } = WebSocket;
import dayjs = require('dayjs');

export interface DanmakuCollectorOptions {
  id: string; // 内部 UUID，用于日志标识
  roomId: string;
  outputDir: string;
  segmentTime: number;
  format?: 'jsonl' | 'xml'; // 输出格式，默认 jsonl
  xmlMetadata?: DanmakuXmlMetadata; // XML 元数据（仅当 format=xml 时使用）
  onSegmentComplete?: (segment: any) => void;
  onError?: (error: Error) => void;
}

/**
 * 弹幕收集服务
 * 每个实例负责一个录制的弹幕收集
 */
@Provide()
@Scope(ScopeEnum.Prototype)
export class DanmakuService extends EventEmitter {
  @App()
  app: Application;

  @Inject()
  danmakuXmlService: DanmakuXmlService;

  @Logger()
  private logger: ILogger;

  private options: DanmakuCollectorOptions | null = null;
  private ws: typeof WS.prototype | null = null;
  private connected = false;
  private messageBuffer: DanmakuMessage[] = [];
  private currentSegmentStart = 0;
  private rotateTimer: NodeJS.Timeout | null = null;

  /**
   * 连接并开始收集
   */
  async start(url: string, options: DanmakuCollectorOptions): Promise<void> {
    if (this.connected) {
      throw new Error('Danmaku collector is already running');
    }

    this.options = options;
    this.messageBuffer = [];
    this.currentSegmentStart = Date.now();

    this.logger.info('Starting danmaku collector', {
      id: options.id,
      roomId: options.roomId,
    });

    // 连接 WebSocket（失败会抛出异常）
    await this.connect(url);

    // 连接成功后启动分片轮转定时器
    this.startRotateTimer();
  }

  /**
   * 停止收集
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping danmaku collector', {
      id: this.options?.id,
    });

    if (this.rotateTimer) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = null;
    }

    if (this.messageBuffer.length > 0) {
      await this.rotateSegment();
    }

    await this.disconnect();
  }

  /**
   * 连接弹幕服务器
   */
  private async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WS(url);

      this.ws.on('open', () => {
        this.connected = true;
        this.logger.info('Danmaku WebSocket connected');
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', error => {
        this.logger.error('Danmaku WebSocket error', { error });
        this.emit('error', error);
        this.options?.onError?.(error);
        // 连接失败，拒绝 Promise
        reject(error);
      });

      this.ws.on('close', () => {
        this.logger.warn('Danmaku WebSocket closed');
        this.connected = false;
        this.emit('close');
      });

      // 超时处理
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Danmaku WebSocket connection timeout'));
        }
      }, 10000);
    });
  }

  /**
   * 断开连接
   */
  private async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * 获取连接状态
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(data: Buffer): void {
    try {
      // 这里需要根据实际平台的弹幕协议来解析
      // 简化实现：假设直接是 JSON
      const message = JSON.parse(data.toString()) as DanmakuMessage;

      // 设置相对时间
      message.timestamp = Date.now() - this.currentSegmentStart;

      this.messageBuffer.push(message);

      // 触发消息事件
      this.emit('message', message);
    } catch (error) {
      // 非JSON消息，忽略
      this.logger.debug('Failed to parse danmaku message', {
        data: data.toString(),
      });
    }
  }

  /**
   * 启动分片轮转定时器
   */
  private startRotateTimer(): void {
    if (!this.options) return;

    const intervalMs = this.options.segmentTime * 1000;

    this.rotateTimer = setInterval(async () => {
      await this.rotateSegment();
    }, intervalMs);
  }

  /**
   * 轮转分片
   */
  private async rotateSegment(): Promise<void> {
    if (!this.options || this.messageBuffer.length === 0) {
      return;
    }

    const segmentTimestamp = this.currentSegmentStart;
    const format = this.options.format || 'jsonl';
    const filename = `${this.formatTimestamp(segmentTimestamp)}.${format}`;
    const filePath = `${this.options.outputDir}/${filename}`;

    try {
      let data: string;
      let s3Key: string;

      if (format === 'xml') {
        // 转换为 XML 格式
        data = this.danmakuXmlService.messagesToXml(this.messageBuffer, {
          metadata: this.options.xmlMetadata,
        });
        s3Key = `danmaku/${this.options.id}/${filename}`;
      } else {
        // 转换为 JSONL 格式
        data =
          this.messageBuffer.map(msg => JSON.stringify(msg)).join('\n') + '\n';
        s3Key = `danmaku/${this.options.id}/${filename}`;
      }

      // 创建分片信息
      const segmentInfo = {
        id: this.options.id,
        timestamp: segmentTimestamp,
        type: 'danmaku',
        localPath: filePath,
        s3Key,
        size: Buffer.byteLength(data),
        data, // 包含实际数据以便上传
        format,
      };

      this.logger.info('Danmaku segment rotated', {
        id: this.options.id,
        filename,
        format,
        messageCount: this.messageBuffer.length,
        size: segmentInfo.size,
      });

      // 触发分片完成事件
      this.emit('segment', segmentInfo);
      this.options.onSegmentComplete?.(segmentInfo);

      // 清空缓冲区
      this.messageBuffer = [];
      this.currentSegmentStart = Date.now();
    } catch (error) {
      this.logger.error('Failed to rotate danmaku segment', {
        id: this.options?.id,
        error: error instanceof Error ? error.message : String(error),
      });

      this.emit('error', error);
      this.options?.onError?.(error as Error);
    }
  }

  /**
   * 格式化时间戳
   */
  private formatTimestamp(timestamp: number): string {
    return dayjs(timestamp).format('YYYYMMDD-HHmmss');
  }
}

/**
 * 弹幕管理器（单例）
 * 负责创建和管理多个 DanmakuService 实例
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class DanmakuManager {
  private services = new Map<string, DanmakuService>();
  private activeCount = 0;

  @App()
  app: Application;

  @Logger()
  private logger: ILogger;

  /**
   * 启动一个弹幕收集器
   */
  async start(
    url: string,
    options: DanmakuCollectorOptions
  ): Promise<DanmakuService> {
    const { id } = options;

    // 检查是否已存在
    if (this.services.has(id)) {
      throw new Error(`Danmaku collector for job ${id} already exists`);
    }

    // 创建新实例（使用原型作用域获取新实例）
    const service = await this.createService();
    await service.start(url, options);

    this.services.set(id, service);
    this.activeCount++;

    return service;
  }

  /**
   * 停止一个弹幕收集器
   */
  async stop(jobId: string): Promise<void> {
    const service = this.services.get(jobId);
    if (!service) {
      this.logger.warn(`Danmaku collector for job ${jobId} not found`);
      return;
    }

    await service.stop();

    this.services.delete(jobId);
    this.activeCount--;

    // 注意：由于是原型作用域，实例会由容器管理，这里只需删除引用
  }

  /**
   * 获取一个弹幕收集器
   */
  get(jobId: string): DanmakuService | undefined {
    return this.services.get(jobId);
  }

  /**
   * 检查收集器是否活跃
   */
  isActive(jobId: string): boolean {
    return this.services.has(jobId);
  }

  /**
   * 获取所有活跃的 jobId
   */
  getActiveJobIds(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * 获取活跃数量
   */
  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * 停止所有收集器
   */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.services.keys()).map(jobId =>
      this.stop(jobId)
    );
    await Promise.all(promises);
  }

  /**
   * 创建新的服务实例（原型作用域）
   */
  private async createService(): Promise<DanmakuService> {
    // 通过应用上下文获取新的原型实例
    const container = this.app.getApplicationContext();
    return await container.getAsync(DanmakuService);
  }
}
