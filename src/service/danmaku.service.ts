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
import * as fsPromises from 'fs/promises';
import { Platform } from '../interface';
import { DanmakuColor, DanmakuMessage } from '../interface/data';
import * as WebSocket from 'ws';
import {
  BilibiliDanmuInfo,
  BilibiliDanmuHost,
  BILIBILI_WS_OPERATION,
  buildBilibiliAuthPacket,
  buildBilibiliHeartbeatPacket,
  decodeBilibiliPackets,
  parseBilibiliDanmakuCommand,
  signBilibiliWbiUrl,
} from './bilibili-danmaku';
import { DanmakuXmlMetadata, DanmakuXmlService } from './danmaku-xml.service';
const { WebSocket: WS } = WebSocket;
import dayjs = require('dayjs');

export interface DanmakuCollectorOptions {
  id: string; // 内部 UUID，用于日志标识
  platform: Platform;
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
  private static bilibiliWbiKeyCache: {
    imgKey: string;
    subKey: string;
    expiresAt: number;
  } | null = null;

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
  private recordingStartTime = 0;
  private rotateTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = false;
  private currentUrl = '';
  private currentBilibiliHost: BilibiliDanmuHost | null = null;
  private bilibiliHosts: BilibiliDanmuHost[] = [];
  private bilibiliHostIndex = 0;
  private bilibiliMessageCounter = 0;

  /**
   * 连接并开始收集
   */
  async start(url: string, options: DanmakuCollectorOptions): Promise<void> {
    if (this.connected || this.ws) {
      throw new Error('Danmaku collector is already running');
    }

    this.options = options;
    this.messageBuffer = [];
    this.recordingStartTime = Date.now();
    this.currentSegmentStart = this.recordingStartTime;
    this.currentUrl = url;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.bilibiliMessageCounter = 0;

    this.logger.info('Starting danmaku collector', {
      id: options.id,
      platform: options.platform,
      roomId: options.roomId,
    });

    // 连接 WebSocket（失败会抛出异常）
    try {
      await this.connect(url);
    } catch (error) {
      this.shouldReconnect = false;
      await this.disconnect();
      throw error;
    }

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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.shouldReconnect = false;

    if (this.messageBuffer.length > 0) {
      await this.rotateSegment();
    }

    await this.disconnect();
  }

  /**
   * 连接弹幕服务器
   */
  private async connect(url: string): Promise<void> {
    if (this.isBilibiliDanmaku(url)) {
      await this.connectBilibili(url);
      return;
    }

    await this.connectLegacy(url);
  }

  private async connectLegacy(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.ws = new WS(url);

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      this.ws.on('open', () => {
        this.connected = true;
        this.logger.info('Danmaku WebSocket connected', {
          id: this.options?.id,
          url,
        });
        finish();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', error => {
        this.logger.error('Danmaku WebSocket error', { error });
        this.emit('error', error);
        this.options?.onError?.(error);
        finish(error instanceof Error ? error : new Error(String(error)));
      });

      this.ws.on('close', (code, reason) => {
        this.logger.warn('Danmaku WebSocket closed', {
          id: this.options?.id,
          code,
          reason: reason.toString(),
          url,
        });
        this.connected = false;
        this.emit('close');
        if (!settled) {
          finish(
            new Error(
              `Danmaku WebSocket closed before startup completed (code=${code})`
            )
          );
        } else if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      // 超时处理
      const startupTimer = setTimeout(() => {
        if (!this.connected) {
          finish(new Error('Danmaku WebSocket connection timeout'));
        }
      }, 10000);

      const cleanup = () => {
        clearTimeout(startupTimer);
      };

      this.ws.once('open', cleanup);
      this.ws.once('error', cleanup);
      this.ws.once('close', cleanup);
    });
  }

  private async connectBilibili(_url: string): Promise<void> {
    const roomId = Number(this.options?.roomId || 0);
    if (!Number.isFinite(roomId) || roomId <= 0) {
      throw new Error(`Invalid Bilibili room id: ${this.options?.roomId}`);
    }

    const actualRoomId = await this.resolveBilibiliRoomId(roomId);
    const danmuInfo = await this.fetchBilibiliDanmuInfo(actualRoomId);
    this.bilibiliHosts = this.getOrderedBilibiliHosts(danmuInfo.host_list);
    this.currentBilibiliHost =
      this.bilibiliHosts[this.bilibiliHostIndex % this.bilibiliHosts.length];
    this.bilibiliHostIndex += 1;

    if (!this.currentBilibiliHost) {
      throw new Error('No available Bilibili danmaku host');
    }

    const wsUrl = `wss://${this.currentBilibiliHost.host}:${this.currentBilibiliHost.wss_port}/sub`;
    const headers = this.buildBilibiliWsHeaders(actualRoomId);

    await new Promise<void>((resolve, reject) => {
      let authenticated = false;
      let settled = false;

      this.ws = new WS(wsUrl, { headers });

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(startupTimer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const startupTimer = setTimeout(() => {
        finish(new Error('Bilibili danmaku authentication timed out'));
      }, 10000);

      this.ws.on('open', () => {
        this.logger.info('Bilibili danmaku socket opened', {
          id: this.options?.id,
          roomId: actualRoomId,
          host: this.currentBilibiliHost?.host,
        });
        this.ws?.send(buildBilibiliAuthPacket(actualRoomId, danmuInfo.token));
      });

      this.ws.on('message', raw => {
        try {
          const buffer = Buffer.isBuffer(raw)
            ? raw
            : Array.isArray(raw)
              ? Buffer.concat(raw)
              : typeof raw === 'string'
                ? Buffer.from(raw)
                : Buffer.from(raw as ArrayBuffer);
          const packets = decodeBilibiliPackets(buffer);
          for (const packet of packets) {
            if (packet.operation === BILIBILI_WS_OPERATION.CONNECT_SUCCESS) {
              const authResult = this.parseBilibiliAuthResult(packet.data);
              if (authResult.code !== 0) {
                finish(
                  new Error(
                    `Bilibili danmaku authentication failed: ${JSON.stringify(
                      authResult
                    )}`
                  )
                );
                return;
              }

              authenticated = true;
              this.connected = true;
              this.reconnectAttempts = 0;
              this.startBilibiliHeartbeat();
              this.logger.info('Bilibili danmaku authenticated', {
                id: this.options?.id,
                roomId: actualRoomId,
                host: this.currentBilibiliHost?.host,
              });
              finish();
              continue;
            }

            if (packet.operation === BILIBILI_WS_OPERATION.HEARTBEAT_REPLY) {
              this.logger.debug('Bilibili danmaku heartbeat reply', {
                id: this.options?.id,
                popularity: packet.data,
              });
              continue;
            }

            if (packet.operation === BILIBILI_WS_OPERATION.MESSAGE) {
              this.handleBilibiliMessages(packet.data);
            }
          }
        } catch (error) {
          const parsedError =
            error instanceof Error ? error : new Error(String(error));
          this.logger.error('Failed to decode Bilibili danmaku packet', {
            id: this.options?.id,
            error: parsedError.message,
          });
          this.emit('error', parsedError);
          this.options?.onError?.(parsedError);
        }
      });

      this.ws.on('error', error => {
        this.logger.error('Bilibili danmaku socket error', {
          id: this.options?.id,
          roomId: actualRoomId,
          host: this.currentBilibiliHost?.host,
          error: error.message,
        });
        if (!authenticated) {
          finish(error);
          return;
        }
        this.emit('error', error);
        this.options?.onError?.(error);
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this.stopBilibiliHeartbeat();
        const closeReason = reason.toString();
        this.logger.warn('Bilibili danmaku socket closed', {
          id: this.options?.id,
          roomId: actualRoomId,
          host: this.currentBilibiliHost?.host,
          code,
          reason: closeReason,
        });
        this.emit('close');
        if (!authenticated) {
          finish(
            new Error(
              `Bilibili danmaku socket closed before authentication completed (code=${code}, reason=${closeReason})`
            )
          );
          return;
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  /**
   * 断开连接
   */
  private async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.stopBilibiliHeartbeat();
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

      // 统一使用相对整场录制的时间轴，便于跨分片检索和索引聚合。
      message.timestamp = Date.now() - this.recordingStartTime;

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

  private handleBilibiliMessages(payload: any): void {
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) {
      const parsed = parseBilibiliDanmakuCommand(
        message,
        Date.now() - this.recordingStartTime,
        () => this.nextBilibiliMessageId()
      );
      if (!parsed) {
        continue;
      }
      if (parsed.color === undefined && parsed.contentColor !== undefined) {
        parsed.color = parsed.contentColor as DanmakuColor;
      }
      this.messageBuffer.push(parsed);
      this.emit('message', parsed);
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

      await fsPromises.mkdir(this.options.outputDir, { recursive: true });
      await fsPromises.writeFile(filePath, data, 'utf-8');

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

  private isBilibiliDanmaku(url: string): boolean {
    return (
      this.options?.platform === 'bilibili' ||
      /broadcastlv\.chat\.bilibili\.com|chat\.bilibili\.com/i.test(url)
    );
  }

  private async resolveBilibiliRoomId(roomId: number): Promise<number> {
    const url = new URL('https://api.live.bilibili.com/room/v1/Room/room_init');
    url.searchParams.set('id', roomId.toString());
    const result = await this.fetchJson<{
      code: number;
      message?: string;
      msg?: string;
      data?: { room_id?: number };
    }>(url.toString(), {
      headers: this.buildBilibiliHttpHeaders(roomId),
    });

    if (result.code !== 0 || !result.data?.room_id) {
      throw new Error(
        `Failed to resolve Bilibili room id: ${result.message || result.msg || result.code}`
      );
    }

    return result.data.room_id;
  }

  private async fetchBilibiliDanmuInfo(
    roomId: number
  ): Promise<BilibiliDanmuInfo> {
    const baseUrl = new URL(
      'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo'
    );
    baseUrl.searchParams.set('id', roomId.toString());
    baseUrl.searchParams.set('type', '0');

    const signedUrl = await this.buildSignedBilibiliUrl(baseUrl);
    const result = await this.fetchJson<{
      code: number;
      message?: string;
      data?: BilibiliDanmuInfo;
    }>(signedUrl.toString(), {
      headers: this.buildBilibiliHttpHeaders(roomId),
    });

    if (result.code !== 0 || !result.data?.token || !result.data.host_list) {
      throw new Error(
        `Failed to fetch Bilibili danmaku config: ${result.message || result.code}`
      );
    }

    return result.data;
  }

  private async buildSignedBilibiliUrl(url: URL): Promise<URL> {
    const { imgKey, subKey } = await this.getBilibiliWbiKeys();
    return signBilibiliWbiUrl(url, imgKey, subKey);
  }

  private extractBilibiliImageKey(url?: string): string {
    return url?.split('/').pop()?.split('.')[0] || '';
  }

  private async getBilibiliWbiKeys(): Promise<{
    imgKey: string;
    subKey: string;
  }> {
    const cached = DanmakuService.bilibiliWbiKeyCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    const nav = await this.fetchJson<{
      data?: {
        wbi_img?: {
          img_url?: string;
          sub_url?: string;
        };
      };
    }>('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
      },
    });

    const imgKey = this.extractBilibiliImageKey(nav.data?.wbi_img?.img_url);
    const subKey = this.extractBilibiliImageKey(nav.data?.wbi_img?.sub_url);

    if (!imgKey || !subKey) {
      throw new Error('Failed to load Bilibili WBI keys');
    }

    const nextCache = {
      imgKey,
      subKey,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    DanmakuService.bilibiliWbiKeyCache = nextCache;

    return nextCache;
  }

  private buildBilibiliHttpHeaders(roomId: number): Record<string, string> {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `https://live.bilibili.com/${roomId}`,
      Origin: 'https://live.bilibili.com',
    };
  }

  private buildBilibiliWsHeaders(roomId: number): Record<string, string> {
    return {
      ...this.buildBilibiliHttpHeaders(roomId),
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
    };
  }

  private getOrderedBilibiliHosts(hosts: BilibiliDanmuHost[]): BilibiliDanmuHost[] {
    const deduped = new Map<string, BilibiliDanmuHost>();
    for (const host of hosts) {
      if (!host?.host || !host.wss_port) {
        continue;
      }
      deduped.set(`${host.host}:${host.wss_port}`, host);
    }
    return Array.from(deduped.values());
  }

  private parseBilibiliAuthResult(payload: any): { code: number } {
    if (payload && typeof payload === 'object') {
      return { code: Number(payload.code ?? 0) };
    }

    if (typeof payload === 'string') {
      try {
        const parsed = JSON.parse(payload);
        return { code: Number(parsed.code ?? 0) };
      } catch {
        return { code: -1 };
      }
    }

    return { code: -1 };
  }

  private startBilibiliHeartbeat(): void {
    this.stopBilibiliHeartbeat();
    if (!this.ws) {
      return;
    }
    this.ws.send(buildBilibiliHeartbeatPacket());
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.connected) {
        this.ws.send(buildBilibiliHeartbeatPacket());
      }
    }, 30000);
  }

  private stopBilibiliHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts += 1;
    const delayMs = Math.min(this.reconnectAttempts * 2000, 30000);
    this.logger.warn('Scheduling danmaku reconnect', {
      id: this.options?.id,
      platform: this.options?.platform,
      roomId: this.options?.roomId,
      attempt: this.reconnectAttempts,
      delayMs,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delayMs);
  }

  private async reconnect(): Promise<void> {
    if (!this.shouldReconnect) {
      return;
    }

    try {
      await this.disconnect();
      await this.connect(this.currentUrl);
      this.logger.info('Danmaku collector reconnected', {
        id: this.options?.id,
        platform: this.options?.platform,
        roomId: this.options?.roomId,
        host: this.currentBilibiliHost?.host,
      });
    } catch (error) {
      const parsedError =
        error instanceof Error ? error : new Error(String(error));
      this.logger.warn('Danmaku reconnect failed', {
        id: this.options?.id,
        platform: this.options?.platform,
        roomId: this.options?.roomId,
        error: parsedError.message,
      });
      this.scheduleReconnect();
    }
  }

  private async fetchJson<T>(
    url: string,
    init?: RequestInit
  ): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  private nextBilibiliMessageId(): string {
    this.bilibiliMessageCounter += 1;
    return `${this.options?.id || 'danmaku'}-${this.bilibiliMessageCounter}`;
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
