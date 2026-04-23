import { ILogger } from '@midwayjs/core';
import * as crypto from 'crypto';
import {
  Platform,
  PlatformAdapter,
  PlatformError,
  RecordingQuality,
  ResolvedStream,
  StreamStatus,
} from '../interface';
import { getHuyaDanmakuUrl } from '../service/huya-danmaku';

interface HuyaStreamData {
  data: Array<{
    gameLiveInfo: HuyaGameLiveInfo;
    gameStreamInfoList: HuyaGameStreamInfo[];
  }>;
  vMultiStreamInfo: HuyaMultiStreamInfo[];
}

interface HuyaGameLiveInfo {
  liveId: string;
  nick: string;
  roomName: string;
  introduction: string;
  roomHttpUrl: string;
  totalCount: number;
  screenshot: string;
  contentIntro: string;
  liveSourceType: number;
  screenType: number;
  iRoomId: number;
  lChannelId: number;
  lSubChannelId: number;
  lPresenterUid: number;
}

interface HuyaGameStreamInfo {
  sCdnType: string;
  sStreamName: string;
  sFlvUrl: string;
  sFlvUrlSuffix: string;
  sFlvAntiCode: string;
  lPresenterUid: number;
  iLineIndex: number;
}

interface HuyaMultiStreamInfo {
  iBitRate: number;
  sDisplayName: string;
}

const STREAM_PARAMS_CONSTANTS = {
  t: 100,
  ver: 1,
  sv: 2401090219,
  codec: 264,
};

const ANTICODE_KEEP_KEYS = new Set(['wsTime', 'fm', 'ctype', 'fs']);

export class HuyaAdapter implements PlatformAdapter {
  readonly name: Platform = 'huya';

  private readonly URL_ROOM_PAGE = 'https://www.huya.com';

  private readonly SHOW_STATUS_ONLINE = 'ON';

  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  async getStreamerStatus(streamerId: string): Promise<StreamStatus> {
    const url = `${this.URL_ROOM_PAGE}/${streamerId}`;
    const html = await this.fetchPage(url);
    const streamData = this.extractStreamData(html);

    if (!streamData?.data?.[0]?.gameLiveInfo) {
      throw new PlatformError(
        'Can not extract the room info',
        'huya',
        'ROOM_INFO_ERROR'
      );
    }

    const roomInfo = streamData.data[0].gameLiveInfo;
    const isLive = this.extractRoomState(html) === this.SHOW_STATUS_ONLINE;

    return {
      isLive,
      roomId: roomInfo.iRoomId?.toString() || streamerId,
      streamerId: roomInfo.lPresenterUid?.toString() || streamerId,
      title: roomInfo.roomName || roomInfo.introduction || '',
      viewerCount: roomInfo.totalCount || 0,
    };
  }

  async getStream(
    streamerId: string,
    quality: RecordingQuality = 'high'
  ): Promise<ResolvedStream> {
    const url = `${this.URL_ROOM_PAGE}/${streamerId}`;
    const html = await this.fetchPage(url);
    const streamData = this.extractStreamData(html);

    if (!streamData?.data?.[0]) {
      throw new PlatformError(
        'Can not extract stream data',
        'huya',
        'STREAM_DATA_ERROR'
      );
    }

    const isLive = this.extractRoomState(html) === this.SHOW_STATUS_ONLINE;

    if (!isLive) {
      throw new PlatformError(
        'Live stream is offline',
        'huya',
        'STREAM_OFFLINE'
      );
    }

    const streamInfoList = streamData.data[0].gameStreamInfoList;
    if (!streamInfoList || streamInfoList.length === 0) {
      throw new PlatformError(
        'Video is offline',
        'huya',
        'NO_STREAM_INFO'
      );
    }

    const candidates = this.buildStreamCandidates(
      streamInfoList,
      streamData.vMultiStreamInfo,
      quality
    );

    for (const candidate of candidates) {
      if (await this.validateStreamUrl(candidate.url)) {
        this.logger?.debug('Using Huya stream URL', { url: candidate.url });
        return {
          url: candidate.url,
          requestedQuality: quality,
          effectiveQuality: candidate.effectiveQuality,
          qualityApplied: true,
        };
      }
    }

    throw new PlatformError(
      'No valid stream URL available',
      'huya',
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

  async getDanmakuUrl(streamerId: string): Promise<string> {
    this.logger?.debug('Resolved Huya danmaku endpoint', {
      streamerId,
    });
    return getHuyaDanmakuUrl();
  }

  async validateStreamerId(streamerId: string): Promise<boolean> {
    try {
      await this.getStreamerStatus(streamerId);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchPage(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      throw new PlatformError(
        `HTTP ${response.status}: ${response.statusText}`,
        'huya',
        'HTTP_ERROR'
      );
    }

    return response.text();
  }

  private extractStreamData(html: string): HuyaStreamData | null {
    const scriptMatch = html.match(
      /<script[^>]*>[\s\S]*var\s+hyPlayerConfig\s*=\s*\{[\s\S]*?<\/script>/
    );
    if (!scriptMatch) {
      this.logger?.warn('hyPlayerConfig script tag not found');
      return null;
    }

    const scriptContent = scriptMatch[0];

    const streamMatch = scriptContent.match(
      /stream\s*:\s*(?:"([A-Za-z0-9+/=]+)"|({[\s\S]*?})\s*}\s*;)/
    );
    if (!streamMatch) {
      this.logger?.warn('stream field not found in hyPlayerConfig');
      return null;
    }

    try {
      let jsonStr: string;
      if (streamMatch[1]) {
        jsonStr = Buffer.from(streamMatch[1], 'base64').toString('utf-8');
      } else if (streamMatch[2]) {
        jsonStr = streamMatch[2];
      } else {
        return null;
      }

      return JSON.parse(jsonStr) as HuyaStreamData;
    } catch (error) {
      this.logger?.warn('Failed to parse Huya stream data', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private extractRoomState(html: string): string {
    const stateMatch = html.match(
      /TT_ROOM_DATA\s*=\s*\{[^}]*state\s*:\s*['"](\w+)['"]/
    );
    if (stateMatch) {
      return stateMatch[1];
    }

    const streamData = this.extractStreamData(html);
    if (streamData?.data?.[0]?.gameStreamInfoList?.length > 0) {
      return 'ON';
    }

    return 'OFF';
  }

  private buildStreamCandidates(
    streamInfoList: HuyaGameStreamInfo[],
    multiStreamInfo: HuyaMultiStreamInfo[],
    requestedQuality: RecordingQuality
  ): Array<{ url: string; effectiveQuality: RecordingQuality }> {
    const urls: Array<{ url: string; effectiveQuality: RecordingQuality }> =
      [];
    const qualities = multiStreamInfo?.length
      ? multiStreamInfo
      : [{ iBitRate: 0, sDisplayName: '' }];
    const prioritizedQualities = this.prioritizeQualities(
      qualities,
      requestedQuality
    );

    for (const streamInfo of streamInfoList) {
      const { sFlvUrl, sStreamName, sFlvUrlSuffix, sFlvAntiCode } = streamInfo;

      if (!sFlvUrl || !sStreamName || !sFlvUrlSuffix) {
        continue;
      }

      const antiCodeParams = this.parseAntiCode(sFlvAntiCode);

      const baseParams: Record<string, string> = {};
      for (const [k, v] of Object.entries(antiCodeParams)) {
        if (ANTICODE_KEEP_KEYS.has(k)) {
          baseParams[k] = v;
        }
      }

      for (const vStream of prioritizedQualities) {
        const baseUrl = this.buildHttpsStreamBaseUrl(
          sFlvUrl,
          sStreamName,
          sFlvUrlSuffix
        );
        const params = this.computeStreamParams(
          baseParams,
          sStreamName,
          vStream.iBitRate
        );

        const queryString = new URLSearchParams(params).toString();
        urls.push({
          url: `${baseUrl}?${queryString}`,
          effectiveQuality: this.classifyHuyaQuality(
            qualities,
            vStream.iBitRate
          ),
        });
      }
    }

    return urls;
  }

  private buildHttpsStreamBaseUrl(
    flvUrl: string,
    streamName: string,
    suffix: string
  ): string {
    try {
      const parsed = new URL(flvUrl);
      return `https://${parsed.host}${parsed.pathname}/${streamName}.${suffix}`;
    } catch {
      return `${flvUrl.replace(/^http:\/\//i, 'https://')}/${streamName}.${suffix}`;
    }
  }

  private prioritizeQualities(
    qualities: HuyaMultiStreamInfo[],
    requestedQuality: RecordingQuality
  ): HuyaMultiStreamInfo[] {
    const sorted = [...qualities].sort((a, b) => a.iBitRate - b.iBitRate);
    if (sorted.length <= 1) {
      return sorted;
    }

    const preferredIndex =
      requestedQuality === 'low'
        ? 0
        : requestedQuality === 'medium'
          ? Math.floor((sorted.length - 1) / 2)
          : sorted.length - 1;

    const [preferred] = sorted.splice(preferredIndex, 1);
    return [preferred, ...sorted.reverse()];
  }

  private classifyHuyaQuality(
    qualities: HuyaMultiStreamInfo[],
    bitrate: number
  ): RecordingQuality {
    const sorted = [...qualities].sort((a, b) => a.iBitRate - b.iBitRate);
    if (sorted.length <= 1) {
      return 'high';
    }
    const index = sorted.findIndex(item => item.iBitRate === bitrate);
    if (index <= 0) return 'low';
    if (index >= sorted.length - 1) return 'high';
    return 'medium';
  }

  private computeStreamParams(
    baseParams: Record<string, string>,
    streamName: string,
    iBitRate: number
  ): Record<string, string> {
    const fm = baseParams['fm'] || '';
    const fs = baseParams['fs'] || '';
    const ctype = baseParams['ctype'] || 'huya_live';
    const wsTime = baseParams['wsTime'] || '';

    const uid = Math.floor(Math.random() * 10000) + 12340000;
    const convertUid = ((uid << 8) | (uid >>> 24)) >>> 0;

    const timestamp = Date.now();
    const seqid = uid + timestamp;

    let fmPrefix = '';
    try {
      const decoded = Buffer.from(
        decodeURIComponent(fm),
        'base64'
      ).toString('utf-8');
      fmPrefix = decoded.split('_')[0];
    } catch {
      fmPrefix = fm;
    }

    const ss = crypto
      .createHash('md5')
      .update(`${seqid}|${ctype}|${STREAM_PARAMS_CONSTANTS.t}`)
      .digest('hex');

    const wsSecret = crypto
      .createHash('md5')
      .update(
        `${fmPrefix}_${convertUid}_${streamName}_${ss}_${wsTime}`
      )
      .digest('hex');

    const params: Record<string, string> = {
      wsSecret,
      wsTime,
      ctype,
      fs,
      seqid: seqid.toString(),
      u: convertUid.toString(),
      sdk_sid: timestamp.toString(),
      t: STREAM_PARAMS_CONSTANTS.t.toString(),
      ver: STREAM_PARAMS_CONSTANTS.ver.toString(),
      sv: STREAM_PARAMS_CONSTANTS.sv.toString(),
      codec: STREAM_PARAMS_CONSTANTS.codec.toString(),
    };

    if (iBitRate) {
      params['ratio'] = iBitRate.toString();
    }

    return params;
  }

  private parseAntiCode(antiCode: string): Record<string, string> {
    const params: Record<string, string> = {};

    try {
      const decoded = antiCode
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, num) =>
          String.fromCharCode(parseInt(num))
        )
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        );

      const searchParams = new URLSearchParams(decoded);
      for (const [key, value] of searchParams.entries()) {
        params[key] = value;
      }
    } catch {
      antiCode.split('&').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx > 0) {
          params[pair.substring(0, idx)] = pair.substring(idx + 1);
        }
      });
    }

    return params;
  }

  private async validateStreamUrl(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: {
          Origin: 'https://www.huya.com',
          Referer: 'https://www.huya.com/',
        },
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
