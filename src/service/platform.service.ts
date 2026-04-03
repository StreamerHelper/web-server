import { App, ILogger, Logger, Provide } from '@midwayjs/core';
import { Application } from '@midwayjs/koa';
import {
  Platform,
  PlatformAdapter,
  PlatformError,
  StreamStatus,
} from '../interface';
import { BilibiliAdapter } from '../platform/bilibili';
import { DouyuAdapter } from '../platform/douyu';
import { HuyaAdapter } from '../platform/huya';

/**
 * 平台服务
 */
@Provide()
export class PlatformService {
  @App()
  app: Application;

  @Logger()
  private logger: ILogger;

  private adapters = new Map<Platform, new (logger: any) => PlatformAdapter>([
    ['bilibili', BilibiliAdapter],
    ['douyu', DouyuAdapter],
    ['huya', HuyaAdapter],
  ]);

  /**
   * 获取平台适配器
   */
  getAdapter(platform: Platform): PlatformAdapter {
    const AdapterClass = this.adapters.get(platform);
    if (!AdapterClass) {
      throw new PlatformError(
        `Unknown platform: ${platform}`,
        platform,
        'UNKNOWN_PLATFORM'
      );
    }
    return new AdapterClass(this.logger);
  }

  /**
   * 检查主播是否正在直播
   */
  async checkLiveStatus(
    platform: Platform,
    streamerId: string
  ): Promise<StreamStatus> {
    const adapter = this.getAdapter(platform);
    return await adapter.getStreamerStatus(streamerId);
  }

  /**
   * 获取直播流 URL
   */
  async getStreamUrl(
    platform: Platform,
    streamerId: string,
    quality?: string
  ): Promise<string> {
    const adapter = this.getAdapter(platform);
    return await adapter.getStreamUrl(streamerId, quality);
  }

  /**
   * 获取弹幕 URL
   */
  async getDanmakuUrl(platform: Platform, streamerId: string): Promise<string> {
    const adapter = this.getAdapter(platform);
    return await adapter.getDanmakuUrl(streamerId);
  }

  /**
   * 验证主播 ID
   */
  async validateStreamerId(
    platform: Platform,
    streamerId: string
  ): Promise<boolean> {
    const adapter = this.getAdapter(platform);
    return await adapter.validateStreamerId(streamerId);
  }
}
