import { Platform, PlatformAdapter, StreamStatus } from '../interface';

/**
 * 斗鱼直播适配器
 */
export class DouyuAdapter implements PlatformAdapter {
  readonly name: Platform = 'douyu';
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
  }

  async getStreamerStatus(streamerId: string): Promise<StreamStatus> {
    const url = `https://www.douyu.com/betard/${streamerId}`;
    try {
      const data = await this.fetchJson<any>(url);

      if (!data.room || data.error !== 0) {
        throw new Error(`Douyu API error: ${data.msg || 'Unknown error'}`);
      }

      const roomInfo = data.room;

      return {
        isLive: roomInfo.show_status === 1,
        roomId: roomInfo.room_id,
        streamerId: roomInfo.owner_uid,
        title: roomInfo.room_name,
        viewerCount: parseInt(roomInfo.room_biz_all?.hot || '0'),
        startTime: roomInfo.show_time ? roomInfo.show_time * 1000 : undefined,
      };
    } catch (error) {
      this.logger?.error('Failed to get Douyu streamer status', {
        streamerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getStreamUrl(streamerId: string): Promise<string> {
    this.logger?.warn('Douyu stream URL parsing not fully implemented', {
      streamerId,
    });
    return `https://douyu.com/${streamerId}`;
  }

  async getDanmakuUrl(streamerId: string): Promise<string> {
    this.logger?.warn('Douyu danmaku URL parsing not fully implemented', {
      streamerId,
    });
    return `wss://danmuproxy.douyu.com/${streamerId}`;
  }

  async validateStreamerId(streamerId: string): Promise<boolean> {
    try {
      await this.getStreamerStatus(streamerId);
      return true;
    } catch {
      return false;
    }
  }

  protected async fetchJson<T = any>(
    url: string,
    options?: RequestInit
  ): Promise<T> {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...options?.headers,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      this.logger?.error('Fetch failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
