import { ILogger } from '@midwayjs/core';
import {
  Platform,
  PlatformAdapter,
  PlatformError,
  RecordingQuality,
  ResolvedStream,
  StreamStatus,
} from '../interface';

interface BilibiliStreamFormat {
  format_name: string;
  codec: BilibiliCodec[];
}

interface BilibiliCodec {
  codec_name: string;
  base_url: string;
  url_info: BilibiliUrlInfo[];
  current_qn?: number;
}

interface BilibiliUrlInfo {
  host: string;
  extra: string;
}

interface BilibiliStreamInfo {
  protocol_name: string;
  format: BilibiliStreamFormat[];
}

interface PlayUrlResponse {
  code: number;
  data?: {
    durl?: Array<{ url: string }>;
  };
}

interface PlayInfoResponse {
  code: number;
  data?: {
    playurl_info?: {
      playurl?: {
        stream: BilibiliStreamInfo[];
      };
    };
  };
}

interface RoomInfoResponse {
  code: number;
  message?: string;
  data?: {
    live_status: number;
    room_id: number;
    uid: number;
    title: string;
    online: number;
    live_time?: number;
  };
}

/**
 * B站直播适配器
 * 实现参考: https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/bilibili.py
 */
export class BilibiliAdapter implements PlatformAdapter {
  readonly name: Platform = 'bilibili';
  private readonly API_BASE = 'https://api.live.bilibili.com';
  private readonly URL_API_V1_PLAYURL = `${this.API_BASE}/room/v1/Room/playUrl`;
  private readonly URL_API_V2_PLAYINFO = `${this.API_BASE}/xlive/web-room/v2/index/getRoomPlayInfo`;
  private readonly URL_ROOM_INFO = `${this.API_BASE}/room/v1/Room/get_info`;

  // 直播状态常量
  // private readonly SHOW_STATUS_OFFLINE = 0;
  private readonly SHOW_STATUS_ONLINE = 1;
  // private readonly SHOW_STATUS_ROUND = 2;

  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  async getStreamerStatus(streamerId: string): Promise<StreamStatus> {
    const url = `${this.URL_ROOM_INFO}?room_id=${streamerId}`;
    const data = await this.fetchJson<RoomInfoResponse>(url);

    if (data.code !== 0 || !data.data) {
      throw new Error(`Bilibili API error: ${data.message || 'Unknown error'}`);
    }

    const roomInfo = data.data;

    return {
      isLive: roomInfo.live_status === this.SHOW_STATUS_ONLINE,
      roomId: roomInfo.room_id.toString(),
      streamerId: roomInfo.uid.toString(),
      title: roomInfo.title,
      viewerCount: roomInfo.online || 0,
      startTime: roomInfo.live_time ? roomInfo.live_time * 1000 : undefined,
    };
  }

  /**
   * 获取直播流 URL
   * 优先级: V1 API (HTTP-FLV) -> V2 API (HLS)
   * 对每个流进行 HEAD 校验，返回第一个有效的流
   */
  async getStream(
    streamerId: string,
    quality: RecordingQuality = 'high'
  ): Promise<ResolvedStream> {
    // 首先尝试 V1 API 获取 HTTP-FLV 流
    const v1Streams = await this.getApiV1PlayUrl(streamerId, quality);
    for (const streamUrl of v1Streams) {
      if (await this.validateStreamUrl(streamUrl, streamerId)) {
        this.logger?.debug('Using V1 API HTTP-FLV stream', { url: streamUrl });
        return {
          url: streamUrl,
          requestedQuality: quality,
          effectiveQuality: quality,
          qualityApplied: true,
        };
      }
    }

    // 回退到 V2 API 获取 HLS 流
    this.logger?.debug('Falling back to V2 API HLS streams');
    const v2Streams = await this.getApiV2PlayInfo(streamerId, quality);
    for (const stream of v2Streams) {
      const streamUrl = stream.url;
      if (await this.validateStreamUrl(streamUrl, streamerId)) {
        this.logger?.debug('Using V2 API HLS stream', { url: streamUrl });
        return {
          url: streamUrl,
          requestedQuality: quality,
          effectiveQuality: stream.effectiveQuality,
          qualityApplied: true,
        };
      }
    }

    throw new PlatformError(
      'No valid stream URL available',
      'bilibili',
      'NO_STREAM_URL'
    );
  }

  async getStreamUrl(
    streamerId: string,
    quality?: RecordingQuality
  ): Promise<string> {
    const resolved = await this.getStream(streamerId, quality);
    return resolved.url;
  }

  /**
   * 校验流 URL 是否有效
   * B 站直播源带防盗链，校验时必须携带与 FFmpeg 一致的 Referer/Origin。
   */
  private async validateStreamUrl(url: string, roomId: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: this.buildStreamRequestHeaders(roomId),
      });
      const isValid = response.status < 400;
      if (!isValid) {
        this.logger?.debug('Stream URL validation failed', {
          url,
          status: response.status,
        });
      }
      return isValid;
    } catch (error) {
      this.logger?.debug('Stream URL validation error', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private buildStreamRequestHeaders(roomId: string): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0',
      Referer: `https://live.bilibili.com/${roomId}`,
      Origin: 'https://live.bilibili.com',
    };
  }

  /**
   * V1 API: 获取 HTTP-FLV 流地址
   * 返回直接的 FLV 流 URL 列表
   */
  private async getApiV1PlayUrl(
    roomId: string,
    quality: RecordingQuality
  ): Promise<string[]> {
    try {
      const params = new URLSearchParams({
        cid: roomId,
        platform: 'web',
        quality: this.mapV1Quality(quality),
      });

      const url = `${this.URL_API_V1_PLAYURL}?${params.toString()}`;
      const data = await this.fetchJson<PlayUrlResponse>(url, {
        headers: {
          Referer: `https://live.bilibili.com/${roomId}`,
        },
      });

      if (data.code === 0 && data.data?.durl) {
        return data.data.durl.map(item => item.url);
      }

      return [];
    } catch (error) {
      this.logger?.warn('V1 API request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * V2 API: 获取 HLS 流地址
   * 返回符合条件 (http_hls + fmp4/ts + avc) 的流 URL 列表
   */
  private async getApiV2PlayInfo(
    roomId: string,
    quality: RecordingQuality
  ): Promise<Array<{ url: string; effectiveQuality: RecordingQuality }>> {
    try {
      for (const qn of this.getPreferredQnList(quality)) {
        const params = new URLSearchParams({
          room_id: roomId,
          no_playurl: '0',
          mask: '1',
          qn: qn.toString(),
          platform: 'web',
          protocol: '0,1',
          format: '0,1,2',
          codec: '0,1,2',
          dolby: '5',
          panorama: '1',
        });

        const url = `${this.URL_API_V2_PLAYINFO}?${params.toString()}`;
        const data = await this.fetchJson<PlayInfoResponse>(url, {
          headers: {
            Referer: `https://live.bilibili.com/${roomId}`,
          },
        });

        if (data.code !== 0 || !data.data?.playurl_info?.playurl?.stream) {
          continue;
        }

        const streams = this.extractHlsStreams(data.data.playurl_info.playurl.stream);
        if (streams.length > 0) {
          return streams;
        }
      }
      return [];
    } catch (error) {
      this.logger?.warn('V2 API request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 从 V2 API 响应中提取 HLS 流
   * 过滤条件: protocol_name == "http_hls", format_name in ("fmp4", "ts"), codec_name == "avc"
   */
  private extractHlsStreams(
    streams: BilibiliStreamInfo[]
  ): Array<{ url: string; effectiveQuality: RecordingQuality }> {
    const urls: Array<{ url: string; effectiveQuality: RecordingQuality }> = [];

    for (const stream of streams) {
      // 只取 http_hls 协议
      if (stream.protocol_name !== 'http_hls') {
        continue;
      }

      for (const format of stream.format) {
        // 只取 fmp4 和 ts 格式
        if (format.format_name !== 'fmp4' && format.format_name !== 'ts') {
          continue;
        }

        for (const codec of format.codec) {
          // 只取 avc 编码
          if (codec.codec_name !== 'avc') {
            continue;
          }

          for (const urlInfo of codec.url_info) {
            const url = `${urlInfo.host}${codec.base_url}${urlInfo.extra}`;
            urls.push({
              url,
              effectiveQuality: this.mapQnToQuality(
                codec.current_qn ?? this.extractQnFromExtra(urlInfo.extra)
              ),
            });
          }
        }
      }
    }

    return urls;
  }

  async getDanmakuUrl(_streamerId: string): Promise<string> {
    return 'wss://broadcastlv.chat.bilibili.com/sub';
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

  private mapV1Quality(quality: RecordingQuality): string {
    switch (quality) {
      case 'low':
        return '2';
      case 'medium':
        return '3';
      default:
        return '4';
    }
  }

  private getPreferredQnList(quality: RecordingQuality): number[] {
    switch (quality) {
      case 'low':
        return [150, 80, 250, 400, 10000];
      case 'medium':
        return [400, 250, 150, 80, 10000];
      default:
        return [10000, 400, 250, 150, 80];
    }
  }

  private extractQnFromExtra(extra: string): number | undefined {
    const qn = new URLSearchParams(extra.replace(/^\?/, '')).get('qn');
    return qn ? Number(qn) : undefined;
  }

  private mapQnToQuality(qn?: number): RecordingQuality {
    if (!qn) return 'high';
    if (qn >= 10000 || qn >= 400) return 'high';
    if (qn >= 250) return 'medium';
    return 'low';
  }
}
