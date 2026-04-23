import {
  Platform,
  PlatformAdapter,
  PlatformError,
  RecordingQuality,
  ResolvedStream,
  StreamStatus,
} from '../interface';
import * as crypto from 'crypto';
import * as vm from 'vm';
import { getDouyuDanmakuUrl } from '../service/douyu-danmaku';

interface DouyuRoomInfo {
  rid?: number | string;
  ownerId?: number | string;
  roomName?: string;
  nickname?: string;
  isLive?: number | string;
  showTime?: number;
}

interface DouyuRoomPageContext {
  pageProps?: {
    room?: {
      roomInfo?: {
        roomInfo?: DouyuRoomInfo;
      };
    };
  };
  crptext?: string;
}

interface DouyuRateSetting {
  name?: string;
  rate?: number;
}

interface DouyuRateStreamResponse {
  code?: number;
  msg?: string;
  data?: {
    url?: string;
    rate?: number;
    settings?: DouyuRateSetting[];
  };
}

interface DouyuPreviewResponse {
  error?: number;
  msg?: string;
  data?: {
    rtmp_url?: string;
    rtmp_live?: string;
    rate?: number;
  };
}

const DOUYU_DEVICE_ID = '10000000000000000000000000003306';
const DOUYU_RATESTREAM_VER = '219032101';
const VM_TIMEOUT_MS = 5_000;

/**
 * 斗鱼直播适配器
 */
export class DouyuAdapter implements PlatformAdapter {
  readonly name: Platform = 'douyu';
  private readonly mobileRoomPageUrl = 'https://m.douyu.com';
  private readonly ratestreamApiUrl =
    'https://m.douyu.com/api/room/ratestream';
  private readonly previewApiBaseUrl =
    'https://playweb.douyucdn.cn/lapi/live/hlsH5Preview';
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
  }

  async getStreamerStatus(streamerId: string): Promise<StreamStatus> {
    const url = `https://www.douyu.com/betard/${streamerId}`;
    try {
      const data = await this.fetchJson<any>(url);
      const apiErrorCode =
        typeof data?.error === 'number' ? data.error : undefined;

      if (!data.room || (apiErrorCode !== undefined && apiErrorCode !== 0)) {
        throw new Error(`Douyu API error: ${data.msg || 'Unknown error'}`);
      }

      const roomInfo = data.room;

      return {
        isLive: roomInfo.show_status === 1 || roomInfo.show_status === '1',
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

  async getStream(
    streamerId: string,
    quality: RecordingQuality = 'high'
  ): Promise<ResolvedStream> {
    const pageContext = await this.fetchRoomPageContext(streamerId);
    const roomInfo = this.extractRoomInfo(pageContext);
    const roomId = this.extractRealRoomId(pageContext, streamerId);

    if (roomInfo?.isLive !== undefined && String(roomInfo.isLive) !== '1') {
      throw new PlatformError(
        'Live stream is offline',
        'douyu',
        'STREAM_OFFLINE'
      );
    }

    const preferredRates = this.getPreferredRateList(quality);
    let lastError: Error | undefined;

    try {
      const signedParams = this.buildSignedParams(roomId, pageContext);

      for (const rate of preferredRates) {
        try {
          return await this.requestRateStream(
            streamerId,
            roomId,
            quality,
            rate,
            signedParams
          );
        } catch (error) {
          lastError =
            error instanceof Error ? error : new Error(String(error));
          this.logger?.warn('Douyu ratestream request failed', {
            streamerId,
            roomId,
            rate,
            error: lastError.message,
          });
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      this.logger?.warn('Douyu signed ratestream bootstrap failed', {
        streamerId,
        roomId,
        error: lastError.message,
      });
    }

    try {
      return await this.requestPreviewStream(streamerId, roomId, quality);
    } catch (error) {
      const previewError =
        error instanceof Error ? error : new Error(String(error));
      throw new PlatformError(
        previewError.message || lastError?.message || 'No valid stream URL',
        'douyu',
        'NO_STREAM_URL'
      );
    }
  }

  async getStreamUrl(
    streamerId: string,
    quality?: RecordingQuality
  ): Promise<string> {
    const resolved = await this.getStream(streamerId, quality);
    return resolved.url;
  }

  async getDanmakuUrl(streamerId: string): Promise<string> {
    this.logger?.debug('Resolved Douyu danmaku endpoint', {
      streamerId,
    });
    return getDouyuDanmakuUrl();
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

  private async fetchText(url: string, options?: RequestInit): Promise<string> {
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

      return await response.text();
    } catch (error) {
      this.logger?.error('Fetch failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async fetchRoomPageContext(
    streamerId: string
  ): Promise<DouyuRoomPageContext> {
    const html = await this.fetchText(`${this.mobileRoomPageUrl}/${streamerId}`);
    const match = html.match(
      /<script id="vike_pageContext" type="application\/json">([\s\S]*?)<\/script>/
    );

    if (!match?.[1]) {
      throw new PlatformError(
        'Can not extract Douyu page context',
        'douyu',
        'ROOM_CONTEXT_ERROR'
      );
    }

    try {
      return JSON.parse(match[1]) as DouyuRoomPageContext;
    } catch (error) {
      throw new PlatformError(
        `Failed to parse Douyu page context: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'douyu',
        'ROOM_CONTEXT_PARSE_ERROR'
      );
    }
  }

  private extractRoomInfo(pageContext: DouyuRoomPageContext): DouyuRoomInfo {
    const roomInfo = pageContext.pageProps?.room?.roomInfo?.roomInfo;
    if (!roomInfo) {
      throw new PlatformError(
        'Can not extract room info from Douyu page context',
        'douyu',
        'ROOM_INFO_ERROR'
      );
    }
    return roomInfo;
  }

  private extractRealRoomId(
    pageContext: DouyuRoomPageContext,
    streamerId: string
  ): string {
    const roomInfo = this.extractRoomInfo(pageContext);
    const roomId = roomInfo.rid;
    if (!roomId) {
      throw new PlatformError(
        'Can not extract real Douyu room ID',
        'douyu',
        'ROOM_ID_ERROR'
      );
    }
    const resolvedRoomId = String(roomId);
    if (resolvedRoomId !== streamerId) {
      this.logger?.debug('Resolved Douyu real room ID', {
        streamerId,
        roomId: resolvedRoomId,
      });
    }
    return resolvedRoomId;
  }

  private buildSignedParams(
    roomId: string,
    pageContext: DouyuRoomPageContext
  ): URLSearchParams {
    const signatureScript = this.extractSignatureScript(pageContext.crptext);
    const bootstrapScript = signatureScript.replace(/eval.*?;}/s, 'strc;}');
    const bootstrapContext: Record<string, unknown> = {};

    vm.createContext(bootstrapContext);
    vm.runInContext(bootstrapScript, bootstrapContext, {
      timeout: VM_TIMEOUT_MS,
    });

    const rawSigner = (bootstrapContext.ub98484234 as undefined | (() => string))
      ?.();
    if (!rawSigner) {
      throw new PlatformError(
        'Can not bootstrap Douyu signer',
        'douyu',
        'STREAM_SIGN_BOOTSTRAP_ERROR'
      );
    }

    const version = rawSigner.match(/v=(\d+)/)?.[1];
    if (!version) {
      throw new PlatformError(
        'Can not extract Douyu signer version',
        'douyu',
        'STREAM_SIGN_VERSION_ERROR'
      );
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const md5 = crypto
      .createHash('md5')
      .update(roomId + DOUYU_DEVICE_ID + timestamp + version)
      .digest('hex');

    let signerScript = rawSigner.replace(/return rt;}\);?/, 'return rt;}');
    signerScript = signerScript.replace('(function (', 'function sign(');
    signerScript = signerScript.replace(
      'CryptoJS.MD5(cb).toString()',
      JSON.stringify(md5)
    );

    const signerContext: Record<string, unknown> = {};
    vm.createContext(signerContext);
    vm.runInContext(signerScript, signerContext, {
      timeout: VM_TIMEOUT_MS,
    });

    const params = (
      signerContext.sign as undefined | ((rid: string, did: string, tt: string) => string)
    )?.(roomId, DOUYU_DEVICE_ID, timestamp);

    if (!params) {
      throw new PlatformError(
        'Can not generate Douyu signed params',
        'douyu',
        'STREAM_SIGN_ERROR'
      );
    }

    return new URLSearchParams(params);
  }

  private extractSignatureScript(crptext?: string): string {
    if (!crptext) {
      throw new PlatformError(
        'Douyu page context does not contain signature script',
        'douyu',
        'SIGNATURE_SCRIPT_MISSING'
      );
    }

    const start = crptext.indexOf('function ub98484234');
    if (start < 0) {
      throw new PlatformError(
        'Can not find Douyu signature function',
        'douyu',
        'SIGNATURE_FUNCTION_MISSING'
      );
    }

    return crptext.slice(start);
  }

  private async requestRateStream(
    streamerId: string,
    roomId: string,
    requestedQuality: RecordingQuality,
    rate: number,
    signedParams: URLSearchParams
  ): Promise<ResolvedStream> {
    const payload = new URLSearchParams(signedParams);
    payload.set('ver', DOUYU_RATESTREAM_VER);
    payload.set('rid', roomId);
    payload.set('rate', String(rate));

    const response = await this.fetchJson<DouyuRateStreamResponse>(
      this.ratestreamApiUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: `${this.mobileRoomPageUrl}/${streamerId}`,
        },
        body: payload.toString(),
      }
    );

    if (response.code !== 0 || !response.data?.url) {
      throw new PlatformError(
        response.msg || 'Douyu ratestream request failed',
        'douyu',
        'RATESTREAM_ERROR'
      );
    }

    const actualRate =
      typeof response.data.rate === 'number' ? response.data.rate : rate;

    return {
      url: this.normalizeStreamUrl(response.data.url),
      requestedQuality,
      effectiveQuality: this.mapRateToQuality(actualRate),
      qualityApplied: true,
    };
  }

  private async requestPreviewStream(
    streamerId: string,
    roomId: string,
    requestedQuality: RecordingQuality
  ): Promise<ResolvedStream> {
    const timestamp = Date.now().toString();
    const auth = crypto
      .createHash('md5')
      .update(roomId + timestamp)
      .digest('hex');

    const response = await this.fetchJson<DouyuPreviewResponse>(
      `${this.previewApiBaseUrl}/${roomId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: `${this.mobileRoomPageUrl}/${streamerId}`,
          rid: roomId,
          time: timestamp,
          auth,
        },
        body: new URLSearchParams({
          rid: roomId,
          did: DOUYU_DEVICE_ID,
        }).toString(),
      }
    );

    const streamBaseUrl = response.data?.rtmp_url;
    const streamPath = response.data?.rtmp_live;
    if (response.error !== 0 || !streamBaseUrl || !streamPath) {
      throw new PlatformError(
        response.msg || 'Douyu preview stream request failed',
        'douyu',
        'PREVIEW_STREAM_ERROR'
      );
    }

    return {
      url: this.normalizeStreamUrl(`${streamBaseUrl}/${streamPath}`),
      requestedQuality,
      effectiveQuality:
        typeof response.data.rate === 'number'
          ? this.mapRateToQuality(response.data.rate)
          : undefined,
      qualityApplied: false,
      note: 'Fell back to Douyu preview stream URL',
    };
  }

  private normalizeStreamUrl(url: string): string {
    return url.replace(/^http:\/\//i, 'https://');
  }

  private getPreferredRateList(quality: RecordingQuality): number[] {
    const rateMap: Record<RecordingQuality, number[]> = {
      high: [0, 3, 2, -1],
      medium: [3, 2, 0, -1],
      low: [2, 3, 0, -1],
    };

    return [...new Set(rateMap[quality] || rateMap.high)];
  }

  private mapRateToQuality(rate: number): RecordingQuality {
    if (rate === 0) {
      return 'high';
    }
    if (rate === 3) {
      return 'medium';
    }
    return 'low';
  }
}
