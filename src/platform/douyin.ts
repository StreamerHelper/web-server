import { ILogger } from '@midwayjs/core';
import {
  Platform,
  PlatformAdapter,
  PlatformError,
  RecordingQuality,
  ResolvedStream,
  StreamStatus,
} from '../interface';

interface DouyinUser {
  nickname?: string;
  avatar_thumb?: {
    url_list?: string[];
  };
}

interface DouyinStats {
  user_count_str?: string;
  total_user_str?: string;
}

interface DouyinRoomViewStats {
  display_value?: number;
}

interface DouyinStreamUrl {
  flv_pull_url?: Record<string, string> | string;
  hls_pull_url_map?: Record<string, string>;
  hls_pull_url?: string;
  rtmp_pull_url?: string;
  default_resolution?: string;
  live_core_sdk_data?: {
    pull_data?: {
      stream_data?: string;
    };
  };
  pull_datas?: Record<string, { stream_data?: string }>;
}

interface DouyinRoom {
  id?: string | number;
  id_str?: string;
  title?: string;
  status?: number | string;
  owner?: DouyinUser;
  anchor?: DouyinUser;
  stats?: DouyinStats;
  room_view_stats?: DouyinRoomViewStats;
  create_time?: number;
  stream_url?: DouyinStreamUrl;
}

interface DouyinRoomInfo {
  room?: DouyinRoom;
  web_rid?: string;
  anchor?: DouyinUser;
}

interface DouyinRoomSnapshot {
  room: DouyinRoom;
  webRid: string;
  anchor?: DouyinUser;
}

interface StreamCandidate {
  url: string;
  protocol: 'flv' | 'hls' | 'rtmp';
  bucket: QualityBucket;
  effectiveQuality: RecordingQuality;
  preference: number;
}

type QualityBucket = 'origin' | 'high' | 'medium' | 'low' | 'unknown';

const DOUYIN_LIVE_STATUS = 2;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 抖音直播适配器。
 *
 * 抖音 Web 直播页会把房间状态和 stream_url 写在 __pace_f 推送的数据块里。
 * 这里优先解析页面内公开播放数据，失败时仅对数字 room_id 尝试旧版 reflow/info 接口。
 */
export class DouyinAdapter implements PlatformAdapter {
  readonly name: Platform = 'douyin';

  private readonly liveBaseUrl = 'https://live.douyin.com';
  private readonly reflowApis = [
    'https://webcast-hl.amemv.com/webcast/room/reflow/info/',
    'https://webcast.amemv.com/webcast/room/reflow/info/',
  ];

  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  async getStreamerStatus(streamerId: string): Promise<StreamStatus> {
    const snapshot = await this.fetchRoomSnapshot(streamerId);
    const { room, webRid, anchor } = snapshot;

    return {
      isLive: this.isLive(room),
      roomId: this.getRoomId(room, webRid),
      streamerId: webRid,
      title: room.title || room.owner?.nickname || anchor?.nickname || '',
      viewerCount: this.getViewerCount(room),
      startTime: room.create_time ? room.create_time * 1000 : undefined,
    };
  }

  async getStream(
    streamerId: string,
    quality: RecordingQuality = 'high'
  ): Promise<ResolvedStream> {
    const snapshot = await this.fetchRoomSnapshot(streamerId);
    const { room, webRid } = snapshot;

    if (!this.isLive(room)) {
      throw new PlatformError(
        'Live stream is offline',
        'douyin',
        'STREAM_OFFLINE'
      );
    }

    if (!room.stream_url) {
      throw new PlatformError(
        'No Douyin stream info available',
        'douyin',
        'NO_STREAM_INFO'
      );
    }

    this.mergeOriginStreams(room.stream_url);

    const candidates = this.buildStreamCandidates(room.stream_url, quality);
    for (const candidate of candidates) {
      if (await this.validateStreamUrl(candidate.url, webRid)) {
        this.logger?.debug('Using Douyin stream URL', {
          streamerId,
          webRid,
          protocol: candidate.protocol,
          effectiveQuality: candidate.effectiveQuality,
        });
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
      'douyin',
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

  async getDanmakuUrl(): Promise<string> {
    return '';
  }

  async validateStreamerId(streamerId: string): Promise<boolean> {
    try {
      await this.fetchRoomSnapshot(streamerId);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchRoomSnapshot(
    streamerId: string
  ): Promise<DouyinRoomSnapshot> {
    const webRid = await this.resolveRoomInput(streamerId);
    const pageUrl = `${this.liveBaseUrl}/${encodeURIComponent(webRid)}`;

    try {
      const html = await this.fetchText(pageUrl, {
        headers: this.buildPageHeaders(webRid),
      });
      const snapshot = this.extractRoomSnapshot(html, webRid);
      if (snapshot) {
        return snapshot;
      }
    } catch (error) {
      this.logger?.warn('Failed to parse Douyin live page', {
        streamerId,
        webRid,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (/^\d{10,}$/.test(webRid)) {
      const fallback = await this.fetchReflowRoom(webRid);
      if (fallback) {
        return fallback;
      }
    }

    throw new PlatformError(
      'Can not extract Douyin room info',
      'douyin',
      'ROOM_INFO_ERROR'
    );
  }

  private extractRoomSnapshot(
    html: string,
    fallbackWebRid: string
  ): DouyinRoomSnapshot | null {
    const fragments = this.extractPaceJsonFragments(html);

    for (const fragment of fragments) {
      const parsed = this.safeJsonParse(fragment);
      const roomInfo = this.findRoomInfo(parsed);
      if (roomInfo?.room) {
        return {
          room: roomInfo.room,
          webRid: roomInfo.web_rid || fallbackWebRid,
          anchor: roomInfo.anchor,
        };
      }
    }

    return this.extractRoomSnapshotByRegex(html, fallbackWebRid);
  }

  private extractPaceJsonFragments(html: string): string[] {
    const marker = '__pace_f';
    const endTag = '</script>';
    const fragments: string[] = [];
    let rest = html;

    while (true) {
      const markerIndex = rest.indexOf(marker);
      if (markerIndex === -1) {
        break;
      }

      rest = rest.slice(markerIndex + marker.length);
      const firstQuoteIndex = rest.indexOf('"');
      if (firstQuoteIndex === -1) {
        break;
      }

      rest = rest.slice(firstQuoteIndex + 1);
      const scriptEndIndex = rest.indexOf(endTag);
      if (scriptEndIndex === -1) {
        break;
      }

      const lastQuoteIndex = rest.slice(0, scriptEndIndex).lastIndexOf('"');
      if (lastQuoteIndex === -1) {
        rest = rest.slice(scriptEndIndex + endTag.length);
        continue;
      }

      const encoded = rest.slice(0, lastQuoteIndex);
      try {
        fragments.push(JSON.parse(`"${encoded}"`));
      } catch {
        // 忽略非 JSON 字符串块，继续尝试后续 __pace_f 数据。
      }

      rest = rest.slice(scriptEndIndex + endTag.length);
    }

    return fragments
      .join('\n')
      .split('\n')
      .map(line => {
        const start = this.firstJsonBoundary(line);
        const end = this.lastJsonBoundary(line);
        if (start === -1 || end === -1 || end <= start) {
          return '';
        }
        return line.slice(start, end + 1);
      })
      .filter(Boolean);
  }

  private firstJsonBoundary(line: string): number {
    const objectIndex = line.indexOf('{');
    const arrayIndex = line.indexOf('[');
    if (objectIndex === -1) {
      return arrayIndex;
    }
    if (arrayIndex === -1) {
      return objectIndex;
    }
    return Math.min(objectIndex, arrayIndex);
  }

  private lastJsonBoundary(line: string): number {
    return Math.max(line.lastIndexOf('}'), line.lastIndexOf(']'));
  }

  private findRoomInfo(value: unknown): DouyinRoomInfo | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findRoomInfo(item);
        if (found) {
          return found;
        }
      }
      return null;
    }

    const record = value as Record<string, unknown>;
    if (this.isRoomInfo(record)) {
      return record as DouyinRoomInfo;
    }

    for (const item of Object.values(record)) {
      const found = this.findRoomInfo(item);
      if (found) {
        return found;
      }
    }

    return null;
  }

  private isRoomInfo(value: Record<string, unknown>): boolean {
    const room = value.room as DouyinRoom | undefined;
    if (!room || typeof room !== 'object') {
      return false;
    }

    return Boolean(
      room.stream_url ||
        room.id_str ||
        room.id ||
        room.title ||
        room.status !== undefined
    );
  }

  private extractRoomSnapshotByRegex(
    html: string,
    fallbackWebRid: string
  ): DouyinRoomSnapshot | null {
    const cleaned = html.replace(/\\u0026/g, '&').replace(/u0026/g, '&');
    const match = cleaned.match(/"roomStore":(\{[\s\S]*?\}),"linkmicStore"/);
    if (!match?.[1]) {
      return null;
    }

    const roomStore = this.safeJsonParse(match[1]) as {
      roomInfo?: DouyinRoomInfo;
    } | null;
    if (!roomStore?.roomInfo?.room) {
      return null;
    }

    return {
      room: roomStore.roomInfo.room,
      webRid: roomStore.roomInfo.web_rid || fallbackWebRid,
      anchor: roomStore.roomInfo.anchor,
    };
  }

  private async fetchReflowRoom(
    roomId: string
  ): Promise<DouyinRoomSnapshot | null> {
    for (const api of this.reflowApis) {
      try {
        const params = new URLSearchParams({
          room_id: roomId,
          live_id: '1',
        });
        const data = await this.fetchJson<any>(`${api}?${params.toString()}`, {
          headers: this.buildPageHeaders(roomId),
        });
        const room = data?.data?.room;
        if (room) {
          return {
            room,
            webRid: room.web_rid || roomId,
            anchor: room.owner,
          };
        }
      } catch (error) {
        this.logger?.debug('Douyin reflow API request failed', {
          roomId,
          api,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  private mergeOriginStreams(streamUrl: DouyinStreamUrl): void {
    const streamDataText = this.getLiveCoreStreamData(streamUrl);
    if (!streamDataText) {
      return;
    }

    const streamData = this.safeJsonParse(streamDataText) as any;
    const originMain = streamData?.data?.origin?.main;
    if (!originMain) {
      return;
    }

    const sdkParams =
      typeof originMain.sdk_params === 'string'
        ? this.safeJsonParse(originMain.sdk_params)
        : originMain.sdk_params;
    const codec =
      sdkParams && typeof sdkParams.VCodec === 'string' ? sdkParams.VCodec : '';

    if (typeof originMain.flv === 'string') {
      streamUrl.flv_pull_url = {
        ORIGIN: this.appendCodec(originMain.flv, codec),
        ...this.normalizeUrlMap(streamUrl.flv_pull_url),
      };
    }

    if (typeof originMain.hls === 'string') {
      streamUrl.hls_pull_url_map = {
        ORIGIN: this.appendCodec(originMain.hls, codec),
        ...this.normalizeUrlMap(streamUrl.hls_pull_url_map),
      };
    }
  }

  private getLiveCoreStreamData(
    streamUrl: DouyinStreamUrl
  ): string | undefined {
    const pullDatas = streamUrl.pull_datas;
    if (pullDatas && typeof pullDatas === 'object') {
      const first = Object.values(pullDatas).find(item => item?.stream_data);
      if (first?.stream_data) {
        return first.stream_data;
      }
    }

    return streamUrl.live_core_sdk_data?.pull_data?.stream_data;
  }

  private buildStreamCandidates(
    streamUrl: DouyinStreamUrl,
    requestedQuality: RecordingQuality
  ): StreamCandidate[] {
    const candidates: StreamCandidate[] = [];
    const seen = new Set<string>();

    const addCandidate = (
      url: string | undefined,
      protocol: StreamCandidate['protocol'],
      key: string
    ) => {
      if (!url || seen.has(url)) {
        return;
      }
      seen.add(url);
      const bucket = this.detectQualityBucket(key, url);
      candidates.push({
        url,
        protocol,
        bucket,
        effectiveQuality: this.toRecordingQuality(bucket),
        preference: this.getQualityPreference(bucket, requestedQuality),
      });
    };

    const flvUrls = this.normalizeUrlMap(streamUrl.flv_pull_url);
    for (const [key, url] of Object.entries(flvUrls)) {
      addCandidate(url, 'flv', key);
    }

    if (streamUrl.rtmp_pull_url) {
      addCandidate(streamUrl.rtmp_pull_url, 'rtmp', 'RTMP');
    }

    const hlsUrls = this.normalizeUrlMap(streamUrl.hls_pull_url_map);
    if (streamUrl.hls_pull_url) {
      hlsUrls.HLS = streamUrl.hls_pull_url;
    }
    for (const [key, url] of Object.entries(hlsUrls)) {
      addCandidate(url, 'hls', key);
    }

    return candidates.sort((a, b) => {
      if (a.preference !== b.preference) {
        return a.preference - b.preference;
      }
      return (
        this.getProtocolPreference(a.protocol) -
        this.getProtocolPreference(b.protocol)
      );
    });
  }

  private normalizeUrlMap(
    value?: Record<string, string> | string
  ): Record<string, string> {
    if (!value) {
      return {};
    }
    if (typeof value === 'string') {
      return { DEFAULT: value };
    }

    return Object.fromEntries(
      Object.entries(value).filter(([, url]) => typeof url === 'string' && url)
    );
  }

  private detectQualityBucket(key: string, url: string): QualityBucket {
    const haystack = `${key} ${url}`.toUpperCase();
    const lower = `${key} ${url}`.toLowerCase();

    if (/ORIGIN|原画|蓝光|FULL[_-]?HD|UHD/.test(haystack)) {
      return 'origin';
    }
    if (/(^|[^A-Z])HD\d?|_hd|[-/]hd/.test(haystack) || lower.includes('_hd')) {
      return 'high';
    }
    if (/(^|[^A-Z])SD\d?|_sd|[-/]sd/.test(haystack) || lower.includes('_sd')) {
      return 'medium';
    }
    if (/(^|[^A-Z])LD\d?|_ld|[-/]ld/.test(haystack) || lower.includes('_ld')) {
      return 'low';
    }

    return 'unknown';
  }

  private getQualityPreference(
    bucket: QualityBucket,
    requestedQuality: RecordingQuality
  ): number {
    const preferences: Record<
      RecordingQuality,
      Record<QualityBucket, number>
    > = {
      high: { origin: 0, high: 1, medium: 2, low: 3, unknown: 4 },
      medium: { medium: 0, high: 1, origin: 2, low: 3, unknown: 4 },
      low: { low: 0, medium: 1, high: 2, origin: 3, unknown: 4 },
    };

    return preferences[requestedQuality][bucket];
  }

  private getProtocolPreference(protocol: StreamCandidate['protocol']): number {
    if (protocol === 'flv') {
      return 0;
    }
    if (protocol === 'hls') {
      return 1;
    }
    return 2;
  }

  private toRecordingQuality(bucket: QualityBucket): RecordingQuality {
    if (bucket === 'low') {
      return 'low';
    }
    if (bucket === 'medium') {
      return 'medium';
    }
    return 'high';
  }

  private async validateStreamUrl(
    url: string,
    webRid: string
  ): Promise<boolean> {
    if (!/^https?:\/\//i.test(url) && !/^rtmp:\/\//i.test(url)) {
      return false;
    }

    if (/^rtmp:\/\//i.test(url)) {
      return true;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...this.buildStreamHeaders(webRid),
          Range: 'bytes=0-0',
        },
        signal: controller.signal,
      });
      await response.body?.cancel();
      return response.status < 400;
    } catch (error) {
      this.logger?.debug('Douyin stream URL validation failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveRoomInput(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return trimmed.split('?')[0].replace(/^\/+|\/+$/g, '');
    }

    const parsed = new URL(trimmed);
    const direct = this.extractRoomIdFromUrl(parsed);
    if (direct) {
      return direct;
    }

    const redirected = await this.resolveRedirect(trimmed);
    const redirectedRoomId = this.extractRoomIdFromUrl(new URL(redirected));
    if (redirectedRoomId) {
      return redirectedRoomId;
    }

    throw new PlatformError(
      'Unsupported Douyin room URL',
      'douyin',
      'UNSUPPORTED_URL'
    );
  }

  private extractRoomIdFromUrl(url: URL): string | null {
    const hostname = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);

    if (hostname === 'live.douyin.com' && parts[0]) {
      return parts[0];
    }

    const rootLiveIndex = parts.findIndex(
      (part, index) => part === 'root' && parts[index + 1] === 'live'
    );
    if (hostname.endsWith('douyin.com') && rootLiveIndex !== -1) {
      return parts[rootLiveIndex + 2] || null;
    }

    return null;
  }

  private async resolveRedirect(url: string): Promise<string> {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: this.buildPageHeaders(''),
    });
    await response.body?.cancel();
    return response.url || url;
  }

  private buildPageHeaders(webRid: string): Record<string, string> {
    return {
      'User-Agent': this.getUserAgent(),
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      Referer: `${this.liveBaseUrl}/${webRid}`,
      Cookie: `__ac_nonce=${this.generateNonce()}`,
    };
  }

  private buildStreamHeaders(webRid: string): Record<string, string> {
    return {
      'User-Agent': this.getUserAgent(),
      Referer: `${this.liveBaseUrl}/${webRid}`,
      Origin: this.liveBaseUrl,
      Cookie: `__ac_nonce=${this.generateNonce()}`,
    };
  }

  private getUserAgent(): string {
    return (
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    );
  }

  private generateNonce(): string {
    return `0${Math.random().toString(16).slice(2, 22).padEnd(20, '0')}`;
  }

  private isLive(room: DouyinRoom): boolean {
    return Number(room.status) === DOUYIN_LIVE_STATUS;
  }

  private getRoomId(room: DouyinRoom, fallback: string): string {
    return room.id_str || String(room.id || fallback);
  }

  private getViewerCount(room: DouyinRoom): number {
    if (typeof room.room_view_stats?.display_value === 'number') {
      return room.room_view_stats.display_value;
    }

    return this.parseChineseCount(
      room.stats?.user_count_str || room.stats?.total_user_str || ''
    );
  }

  private parseChineseCount(value: string): number {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }

    const match = trimmed.match(/^([\d.]+)\s*([万億亿]?)$/);
    if (!match) {
      const numeric = Number(trimmed.replace(/[^\d.]/g, ''));
      return Number.isFinite(numeric) ? numeric : 0;
    }

    const base = Number(match[1]);
    if (!Number.isFinite(base)) {
      return 0;
    }

    if (match[2] === '万') {
      return Math.round(base * 10_000);
    }
    if (match[2] === '亿' || match[2] === '億') {
      return Math.round(base * 100_000_000);
    }
    return Math.round(base);
  }

  private appendCodec(url: string, codec: string): string {
    if (!codec || /[?&]codec=/i.test(url)) {
      return url;
    }
    return `${url}${url.includes('?') ? '&' : '?'}codec=${encodeURIComponent(
      codec
    )}`;
  }

  private safeJsonParse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private async fetchText(url: string, options?: RequestInit): Promise<string> {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.text();
  }

  private async fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as T;
  }
}
