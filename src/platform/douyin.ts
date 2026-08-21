import { ILogger } from '@midwayjs/core';
import {
  Platform,
  PlatformAdapter,
  PlatformError,
  RecordingQuality,
  ResolvedStream,
  StreamStatus,
} from '../interface';
import { getConfig } from '../config/loader';
import {
  sanitizeStreamUrl,
  sanitizeUrlQueriesInText,
} from '../utils/sensitive-url';

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
  fallbackStreamHeaders?: Record<string, string>;
  resolverStream?: {
    url: string;
    headers?: Record<string, string>;
    effectiveQuality?: RecordingQuality;
  };
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
const RESOLVER_REQUEST_TIMEOUT_MS = 25_000;
const STREAM_VALIDATION_TIMEOUT_MS = 8_000;
const STREAM_VALIDATION_MAX_BYTES = 4 * 1024;
const RESOLVER_BUSY_RETRY_MS = 5_000;
export const DOUYIN_CAPTCHA_ERROR_CODE = 'DOUYIN_CAPTCHA_REQUIRED';
export const DOUYIN_BACKOFF_ERROR_CODE = 'DOUYIN_BACKOFF';
const GUEST_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;
const RESOLVER_CACHE_TTL_MS = 5_000;
const RESOLVER_CACHE_MAX_ENTRIES = 256;
const OFFLINE_CONFIRMATION_TTL_MS = 30_000;
const RESOLVER_MEDIA_CIRCUIT_BASE_DELAY_MS = 30_000;
const RESOLVER_MEDIA_CIRCUIT_MAX_DELAY_MS = 5 * 60 * 1000;
const RESOLVER_MEDIA_CIRCUIT_MAX_ENTRIES = 256;
const CIRCUIT_BASE_DELAY_MS = 30_000;
const CIRCUIT_MAX_DELAY_MS = 5 * 60 * 1000;
const CIRCUIT_MAX_ENTRIES = 256;
const GLOBAL_CIRCUIT_KEY = '*';

export type DouyinBrowserPageOutcome =
  | 'ok'
  | 'challenged'
  | 'expired'
  | 'transient';

export interface DouyinBrowserPageResult {
  html: string;
  outcome: DouyinBrowserPageOutcome;
  error?: string;
}

export interface DouyinAdapterOptions {
  browserPageProvider?: (webRid: string) => Promise<DouyinBrowserPageResult>;
  onBrowserOutcome?: (
    outcome: DouyinBrowserPageOutcome,
    error?: string
  ) => Promise<void>;
}

type DouyinResolverResponse =
  | {
      state: 'live';
      roomId?: string;
      title?: string;
      stream: {
        url: string;
        headers?: Record<string, string>;
        effectiveQuality?: RecordingQuality;
      };
    }
  | {
      state: 'offline';
      roomId?: string;
      title?: string;
    }
  | {
      state: 'unavailable';
      code: string;
      message: string;
    };

/**
 * 抖音直播适配器。
 *
 * 录播主链只使用匿名身份：动态申请 ttwid，解析公开页面及 reflow 数据。
 * 持久化浏览器只作为最后回退，账号登录态不是正常录制的前置条件。
 */
export class DouyinAdapter implements PlatformAdapter {
  readonly name: Platform = 'douyin';

  private static guestCookieCache:
    | {
        value: string;
        expiresAt: number;
      }
    | undefined;
  private static circuits = new Map<
    string,
    { failureCount: number; retryAt: number; reason: string }
  >();
  private static resolverCache = new Map<
    string,
    { expiresAt: number; snapshot: DouyinRoomSnapshot }
  >();
  private static offlineConfirmations = new Map<
    string,
    { expiresAt: number; snapshot: DouyinRoomSnapshot }
  >();
  private static resolverMediaCircuits = new Map<
    string,
    { failureCount: number; retryAt: number }
  >();

  private readonly liveBaseUrl = 'https://live.douyin.com';
  private readonly reflowApis = [
    'https://webcast-hl.amemv.com/webcast/room/reflow/info/',
    'https://webcast.amemv.com/webcast/room/reflow/info/',
  ];

  private logger: ILogger;
  private options: DouyinAdapterOptions;

  constructor(logger: ILogger, options?: DouyinAdapterOptions) {
    this.logger = logger;
    this.options = options || {};
  }

  async getStreamerStatus(streamerId: string): Promise<StreamStatus> {
    const snapshot = await this.fetchRoomSnapshot(streamerId, 'high');
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
    let snapshot = await this.fetchRoomSnapshot(streamerId, quality);
    let { room, webRid } = snapshot;

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

    if (snapshot.resolverStream) {
      const resolverStream = snapshot.resolverStream;
      const mediaCircuitOpen = this.isResolverMediaCircuitOpen(webRid, quality);
      if (
        !mediaCircuitOpen &&
        (await this.validateStreamUrl(
          resolverStream.url,
          resolverStream.headers || {},
          'flv'
        ))
      ) {
        this.resetResolverMediaCircuit(webRid, quality);
        this.resetRoomCircuit(webRid);
        return {
          url: resolverStream.url,
          headers: resolverStream.headers,
          requestedQuality: quality,
          effectiveQuality: resolverStream.effectiveQuality || quality,
          qualityApplied: true,
        };
      }

      if (!mediaCircuitOpen) {
        const retryAfterMs = this.openResolverMediaCircuit(webRid, quality);
        this.logger?.warn(
          'Douyin resolver returned an unreadable media stream; using fallback',
          {
            streamerId,
            webRid,
            quality,
            url: sanitizeStreamUrl(resolverStream.url),
            retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
          }
        );
      } else {
        this.logger?.debug(
          'Douyin resolver media validation is cooling down; using fallback',
          { streamerId, webRid, quality }
        );
      }

      snapshot = await this.fetchFallbackRoomSnapshot(webRid, streamerId);
      room = snapshot.room;
      webRid = snapshot.webRid;

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
    }

    this.mergeOriginStreams(room.stream_url);

    const streamHeaders =
      snapshot.fallbackStreamHeaders ||
      this.buildStreamHeaders(webRid, await this.buildDouyinCookie(webRid));
    const candidates = this.buildStreamCandidates(room.stream_url, quality);
    for (const candidate of candidates) {
      if (
        await this.validateStreamUrl(
          candidate.url,
          streamHeaders,
          candidate.protocol
        )
      ) {
        this.logger?.debug('Using Douyin stream URL', {
          streamerId,
          webRid,
          protocol: candidate.protocol,
          effectiveQuality: candidate.effectiveQuality,
        });
        return {
          url: candidate.url,
          headers: streamHeaders,
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
      const webRid = await this.resolveRoomInput(streamerId);
      return this.isValidRoomIdentifier(webRid);
    } catch {
      return false;
    }
  }

  private async fetchRoomSnapshot(
    streamerId: string,
    quality: RecordingQuality = 'high'
  ): Promise<DouyinRoomSnapshot> {
    const webRid = await this.resolveRoomInput(streamerId);
    this.pruneResolverCache();
    const resolverSnapshot = await this.fetchResolverRoom(webRid, quality);
    if (resolverSnapshot) {
      if (this.isLive(resolverSnapshot.room)) {
        DouyinAdapter.offlineConfirmations.delete(webRid);
        return resolverSnapshot;
      }

      // Anonymous resolver responses can be room-specific false negatives.
      // Only accept offline after the independent fallback agrees.
      const confirmed = DouyinAdapter.offlineConfirmations.get(webRid);
      if (confirmed && confirmed.expiresAt > Date.now()) {
        return confirmed.snapshot;
      }
      DouyinAdapter.offlineConfirmations.delete(webRid);

      const fallbackSnapshot = await this.fetchFallbackRoomSnapshot(
        webRid,
        streamerId
      );
      if (this.isLive(fallbackSnapshot.room)) {
        this.logger?.warn(
          'Douyin resolver reported offline but fallback detected a live stream',
          { streamerId, webRid }
        );
        return fallbackSnapshot;
      }

      if (
        DouyinAdapter.offlineConfirmations.size >= RESOLVER_CACHE_MAX_ENTRIES
      ) {
        const oldestKey = DouyinAdapter.offlineConfirmations
          .keys()
          .next().value;
        if (typeof oldestKey === 'string') {
          DouyinAdapter.offlineConfirmations.delete(oldestKey);
        }
      }
      DouyinAdapter.offlineConfirmations.set(webRid, {
        expiresAt: Date.now() + OFFLINE_CONFIRMATION_TTL_MS,
        snapshot: fallbackSnapshot,
      });
      return fallbackSnapshot;
    }

    return await this.fetchFallbackRoomSnapshot(webRid, streamerId);
  }

  private async fetchFallbackRoomSnapshot(
    webRid: string,
    streamerId: string = webRid
  ): Promise<DouyinRoomSnapshot> {
    this.assertFallbackCircuitClosed(webRid);

    const pageUrl = `${this.liveBaseUrl}/${encodeURIComponent(webRid)}`;
    let captchaDetected = false;
    const fallbackCookie = await this.buildDouyinCookie(webRid);
    const fallbackStreamHeaders = this.buildStreamHeaders(
      webRid,
      fallbackCookie
    );

    if (/^\d{10,}$/.test(webRid)) {
      const reflow = await this.fetchReflowRoom(webRid, fallbackCookie);
      if (reflow) {
        this.resetFallbackCircuit(webRid);
        return { ...reflow, fallbackStreamHeaders };
      }
    }

    try {
      const html = await this.fetchText(pageUrl, {
        headers: this.buildPageHeaders(webRid, fallbackCookie),
      });

      if (this.isCaptchaPage(html)) {
        captchaDetected = true;
      } else {
        const snapshot = this.extractRoomSnapshot(html, webRid);
        if (snapshot) {
          this.resetFallbackCircuit(webRid);
          return { ...snapshot, fallbackStreamHeaders };
        }
      }
    } catch (error) {
      this.logger?.warn('Failed to parse Douyin live page', {
        streamerId,
        webRid,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.options.browserPageProvider) {
      try {
        const browserResult = await this.options.browserPageProvider(webRid);
        await this.options.onBrowserOutcome?.(
          browserResult.outcome,
          browserResult.error
        );
        if (browserResult.outcome === 'challenged') {
          captchaDetected = true;
        } else if (browserResult.outcome === 'ok') {
          const snapshot = this.extractRoomSnapshot(browserResult.html, webRid);
          if (snapshot) {
            this.resetFallbackCircuit(webRid);
            return { ...snapshot, fallbackStreamHeaders };
          }
        }
      } catch (error) {
        this.logger?.debug('Douyin browser fallback failed', {
          streamerId,
          webRid,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.options.onBrowserOutcome?.(
          'transient',
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    if (captchaDetected) {
      const retryAfterMs = this.openCircuit('captcha', webRid);
      throw new PlatformError(
        `Douyin captcha verification required; anonymous resolver will retry in ${Math.ceil(
          retryAfterMs / 1000
        )} seconds.`,
        'douyin',
        DOUYIN_CAPTCHA_ERROR_CODE
      );
    }

    const retryAfterMs = this.openCircuit('room-info', webRid);
    throw new PlatformError(
      `Can not extract Douyin room info; resolver will retry in ${Math.ceil(
        retryAfterMs / 1000
      )} seconds.`,
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
    roomId: string,
    cookie: string
  ): Promise<DouyinRoomSnapshot | null> {
    for (const api of this.reflowApis) {
      try {
        const params = new URLSearchParams({
          room_id: roomId,
          live_id: '1',
        });
        const data = await this.fetchJson<any>(`${api}?${params.toString()}`, {
          headers: this.buildPageHeaders(roomId, cookie),
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

  private async fetchResolverRoom(
    webRid: string,
    quality: RecordingQuality
  ): Promise<DouyinRoomSnapshot | null> {
    const resolverUrl = process.env.DOUYIN_RESOLVER_URL?.trim();
    if (!resolverUrl) {
      return null;
    }

    const cacheKey = `${resolverUrl}:${webRid}:${quality}`;
    this.pruneResolverCache();
    const cached = DouyinAdapter.resolverCache.get(cacheKey);
    if (cached) {
      return cached.snapshot;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      RESOLVER_REQUEST_TIMEOUT_MS
    );
    try {
      const response = await fetch(new URL('/v1/douyin/resolve', resolverUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: `${this.liveBaseUrl}/${encodeURIComponent(webRid)}`,
          quality,
          protocol: 'flv',
        }),
        signal: controller.signal,
      });
      const payload = this.parseResolverResponse(await response.json());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (payload.state === 'unavailable') {
        if (payload.code === 'BUSY') {
          throw new PlatformError(
            `Douyin resolver is busy; retry in ${Math.ceil(
              RESOLVER_BUSY_RETRY_MS / 1000
            )} seconds.`,
            'douyin',
            DOUYIN_BACKOFF_ERROR_CODE
          );
        }
        throw new Error(`${payload.code}: ${payload.message}`);
      }

      const roomId = payload.roomId || webRid;
      const snapshot: DouyinRoomSnapshot =
        payload.state === 'live'
          ? {
              webRid,
              room: {
                id_str: roomId,
                title: payload.title || '',
                status: DOUYIN_LIVE_STATUS,
                stream_url: {
                  flv_pull_url: payload.stream.url,
                },
              },
              resolverStream: {
                url: payload.stream.url,
                headers: this.normalizeResolverHeaders(payload.stream.headers),
                effectiveQuality: payload.stream.effectiveQuality,
              },
            }
          : {
              webRid,
              room: {
                id_str: roomId,
                title: payload.title || '',
                status: 4,
              },
            };

      this.pruneResolverCache();
      if (DouyinAdapter.resolverCache.size >= RESOLVER_CACHE_MAX_ENTRIES) {
        const oldestKey = DouyinAdapter.resolverCache.keys().next().value;
        if (typeof oldestKey === 'string') {
          DouyinAdapter.resolverCache.delete(oldestKey);
        }
      }
      DouyinAdapter.resolverCache.set(cacheKey, {
        expiresAt: Date.now() + RESOLVER_CACHE_TTL_MS,
        snapshot,
      });
      return snapshot;
    } catch (error) {
      if (
        error instanceof PlatformError &&
        error.code === DOUYIN_BACKOFF_ERROR_CODE
      ) {
        throw error;
      }
      this.logger?.debug('Douyin resolver sidecar request failed', {
        webRid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseResolverResponse(value: unknown): DouyinResolverResponse {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid Douyin resolver response');
    }

    const payload = value as Record<string, unknown>;
    const roomId = this.optionalResolverString(payload.roomId);
    const title = this.optionalResolverString(payload.title);

    if (payload.state === 'offline') {
      return {
        state: 'offline',
        roomId,
        title,
      };
    }

    if (payload.state === 'unavailable') {
      if (
        typeof payload.code !== 'string' ||
        typeof payload.message !== 'string'
      ) {
        throw new Error('Invalid Douyin resolver response');
      }
      return {
        state: 'unavailable',
        code: payload.code,
        message: payload.message,
      };
    }

    if (
      payload.state !== 'live' ||
      !payload.stream ||
      typeof payload.stream !== 'object' ||
      Array.isArray(payload.stream)
    ) {
      throw new Error('Invalid Douyin resolver response');
    }

    const stream = payload.stream as Record<string, unknown>;
    if (typeof stream.url !== 'string' || !/^https?:\/\//i.test(stream.url)) {
      throw new Error('Invalid Douyin resolver response');
    }
    if (
      stream.effectiveQuality !== undefined &&
      !this.isRecordingQuality(stream.effectiveQuality)
    ) {
      throw new Error('Invalid Douyin resolver response');
    }
    if (
      stream.headers !== undefined &&
      (!stream.headers ||
        typeof stream.headers !== 'object' ||
        Array.isArray(stream.headers) ||
        Object.values(stream.headers).some(value => typeof value !== 'string'))
    ) {
      throw new Error('Invalid Douyin resolver response');
    }

    return {
      state: 'live',
      roomId,
      title,
      stream: {
        url: stream.url,
        headers: stream.headers as Record<string, string> | undefined,
        effectiveQuality: stream.effectiveQuality as
          | RecordingQuality
          | undefined,
      },
    };
  }

  private optionalResolverString(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new Error('Invalid Douyin resolver response');
    }
    return value;
  }

  private isRecordingQuality(value: unknown): value is RecordingQuality {
    return value === 'high' || value === 'medium' || value === 'low';
  }

  private pruneResolverCache(): void {
    const now = Date.now();
    for (const [key, entry] of DouyinAdapter.resolverCache) {
      if (entry.expiresAt <= now) {
        DouyinAdapter.resolverCache.delete(key);
      }
    }
    for (const [key, entry] of DouyinAdapter.offlineConfirmations) {
      if (entry.expiresAt <= now) {
        DouyinAdapter.offlineConfirmations.delete(key);
      }
    }
  }

  private normalizeResolverHeaders(
    headers?: Record<string, string>
  ): Record<string, string> | undefined {
    if (!headers) {
      return undefined;
    }
    const normalized: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const normalizedName = name.toLowerCase();
      if (
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
        ['cookie', 'user-agent', 'referer', 'origin'].includes(
          normalizedName
        ) &&
        typeof value === 'string' &&
        !/[\r\n]/.test(value) &&
        value.length <= 16 * 1024
      ) {
        normalized[name] = value;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
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
    streamHeaders: Record<string, string>,
    protocol: StreamCandidate['protocol'] = 'flv'
  ): Promise<boolean> {
    if (!/^https?:\/\//i.test(url) && !/^rtmp:\/\//i.test(url)) {
      return false;
    }

    if (/^rtmp:\/\//i.test(url)) {
      return true;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      STREAM_VALIDATION_TIMEOUT_MS
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: streamHeaders,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return false;
      }

      reader = response.body.getReader();
      const header = new Uint8Array(STREAM_VALIDATION_MAX_BYTES);
      let length = 0;
      while (length < STREAM_VALIDATION_MAX_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (!chunk.value?.byteLength) {
          continue;
        }
        const remaining = STREAM_VALIDATION_MAX_BYTES - length;
        const bytesToCopy = Math.min(chunk.value.byteLength, remaining);
        header.set(chunk.value.subarray(0, bytesToCopy), length);
        length += bytesToCopy;

        const validation = this.validateMediaHeader(
          header.subarray(0, length),
          protocol
        );
        if (validation !== undefined) {
          return validation;
        }
      }

      return (
        this.validateMediaHeader(header.subarray(0, length), protocol) === true
      );
    } catch (error) {
      this.logger?.debug('Douyin stream URL validation failed', {
        url: sanitizeStreamUrl(url),
        error: sanitizeUrlQueriesInText(
          error instanceof Error ? error.message : String(error)
        ),
      });
      return false;
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // The timeout can already have errored the response body.
        }
        try {
          reader.releaseLock();
        } catch {
          // Ignore readers whose lock was already released by the runtime.
        }
      }
      clearTimeout(timer);
    }
  }

  private validateMediaHeader(
    bytes: Uint8Array,
    protocol: StreamCandidate['protocol']
  ): boolean | undefined {
    if (protocol === 'hls') {
      const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
      if (text.trimStart().startsWith('#EXTM3U')) {
        return true;
      }
      return bytes.byteLength >= STREAM_VALIDATION_MAX_BYTES
        ? false
        : undefined;
    }

    if (protocol !== 'flv') {
      return false;
    }
    if (bytes.byteLength < 3) {
      return undefined;
    }
    if (bytes[0] !== 0x46 || bytes[1] !== 0x4c || bytes[2] !== 0x56) {
      return false;
    }
    if (bytes.byteLength < 9) {
      return undefined;
    }

    const dataOffset =
      bytes[5] * 0x1000000 + bytes[6] * 0x10000 + bytes[7] * 0x100 + bytes[8];
    if (
      bytes[3] !== 1 ||
      (bytes[4] & 0xfa) !== 0 ||
      dataOffset < 9 ||
      dataOffset > STREAM_VALIDATION_MAX_BYTES - 4
    ) {
      return false;
    }
    const firstTagOffset = dataOffset + 4;
    if (bytes.byteLength < firstTagOffset + 12) {
      return undefined;
    }
    if (
      bytes[dataOffset] === 0 &&
      bytes[dataOffset + 1] === 0 &&
      bytes[dataOffset + 2] === 0 &&
      bytes[dataOffset + 3] === 0
    ) {
      const tagType = bytes[firstTagOffset] & 0x1f;
      const dataSize =
        bytes[firstTagOffset + 1] * 0x10000 +
        bytes[firstTagOffset + 2] * 0x100 +
        bytes[firstTagOffset + 3];
      return (
        (tagType === 8 || tagType === 9 || tagType === 18) &&
        dataSize > 0 &&
        bytes[firstTagOffset + 8] === 0 &&
        bytes[firstTagOffset + 9] === 0 &&
        bytes[firstTagOffset + 10] === 0
      );
    }
    return false;
  }

  private async resolveRoomInput(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return trimmed.split('?')[0].replace(/^\/+|\/+$/g, '');
    }

    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') {
      throw new PlatformError(
        'Unsupported Douyin room URL',
        'douyin',
        'UNSUPPORTED_URL'
      );
    }
    const direct = this.extractRoomIdFromUrl(parsed);
    if (direct) {
      return direct;
    }
    if (hostname !== 'v.douyin.com') {
      throw new PlatformError(
        'Unsupported Douyin room URL',
        'douyin',
        'UNSUPPORTED_URL'
      );
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

    const rootLiveIndex = parts.findIndex(
      (part, index) => part === 'root' && parts[index + 1] === 'live'
    );
    if (
      (hostname === 'douyin.com' || hostname.endsWith('.douyin.com')) &&
      rootLiveIndex !== -1
    ) {
      return parts[rootLiveIndex + 2] || null;
    }

    if (hostname === 'live.douyin.com' && parts[0]) {
      return parts[0];
    }

    return null;
  }

  private isValidRoomIdentifier(value: string): boolean {
    return /^[A-Za-z0-9_-]+$/.test(value);
  }

  private async resolveRedirect(url: string): Promise<string> {
    return await this.fetchWithTimeout(
      url,
      {
        redirect: 'follow',
        headers: this.buildPageHeaders('', await this.buildDouyinCookie('')),
      },
      async response => {
        const redirectedUrl = response.url || url;
        await response.body?.cancel();
        return redirectedUrl;
      }
    );
  }

  private buildPageHeaders(
    webRid: string,
    cookie?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.getUserAgent(),
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Referer: `${this.liveBaseUrl}/${webRid}`,
    };
    if (cookie) {
      headers.Cookie = cookie;
    }
    return headers;
  }

  private buildStreamHeaders(
    webRid: string,
    cookie?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.getUserAgent(),
      Referer: `${this.liveBaseUrl}/${webRid}`,
      Origin: this.liveBaseUrl,
    };
    if (cookie) {
      headers.Cookie = cookie;
    }
    return headers;
  }

  private getUserAgent(): string {
    return (
      getConfig().platforms?.douyin?.userAgent?.trim() ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
    );
  }

  private async buildDouyinCookie(webRid: string): Promise<string> {
    return this.mergeCookieHeaders(
      await this.getGuestCookie(webRid),
      `odin_ttid=${this.generateRandomHex(160)}`,
      `__ac_nonce=${this.generateNonce()}`
    );
  }

  private async getGuestCookie(webRid: string): Promise<string> {
    const cached = DouyinAdapter.guestCookieCache;
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.value.includes('ttwid=')
    ) {
      return cached.value;
    }
    DouyinAdapter.guestCookieCache = undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        'https://ttwid.bytedance.com/ttwid/union/register/',
        {
          method: 'POST',
          headers: {
            'User-Agent': this.getUserAgent(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            region: 'cn',
            aid: 6383,
            needFid: false,
            service: 'https://www.douyin.com',
            union: true,
            fid: '',
          }),
          signal: controller.signal,
        }
      );
      await response.body?.cancel();
      const cookie = this.extractSetCookieHeader(response.headers);
      if (!cookie.includes('ttwid=')) {
        throw new Error('ttwid registration did not return a ttwid cookie');
      }
      DouyinAdapter.guestCookieCache = {
        value: cookie,
        expiresAt: Date.now() + GUEST_COOKIE_TTL_MS,
      };
      return cookie;
    } catch (error) {
      this.logger?.debug('Failed to register Douyin ttwid', {
        webRid,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }

    const fallbackController = new AbortController();
    const fallbackTimer = setTimeout(
      () => fallbackController.abort(),
      REQUEST_TIMEOUT_MS
    );
    try {
      const response = await fetch(this.liveBaseUrl, {
        headers: {
          'User-Agent': this.getUserAgent(),
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
          Referer: `${this.liveBaseUrl}/${webRid}`,
        },
        signal: fallbackController.signal,
      });
      await response.body?.cancel();
      const cookie = this.extractSetCookieHeader(response.headers);
      if (!cookie.includes('ttwid=')) {
        this.logger?.debug(
          'Douyin fallback page did not return a ttwid cookie',
          { webRid }
        );
        return '';
      }
      DouyinAdapter.guestCookieCache = {
        value: cookie,
        expiresAt: Date.now() + GUEST_COOKIE_TTL_MS,
      };
      return cookie;
    } catch (error) {
      this.logger?.debug('Failed to prepare Douyin guest cookie', {
        webRid,
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    } finally {
      clearTimeout(fallbackTimer);
    }
  }

  private extractSetCookieHeader(headers: Headers): string {
    const headersWithSetCookie = headers as Headers & {
      getSetCookie?: () => string[];
    };
    const values =
      headersWithSetCookie.getSetCookie?.() ||
      [headers.get('set-cookie')].filter(Boolean);

    return values.map(value => value.split(';')[0]).join('; ');
  }

  private mergeCookieHeaders(...headers: string[]): string {
    const cookies = new Map<string, string>();

    for (const header of headers) {
      if (!header) {
        continue;
      }
      for (const part of header.split(';')) {
        const trimmed = part.trim();
        const separator = trimmed.indexOf('=');
        if (separator <= 0) {
          continue;
        }
        const name = trimmed.slice(0, separator);
        cookies.set(name, trimmed.slice(separator + 1));
      }
    }

    return Array.from(cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  private isCaptchaPage(html: string): boolean {
    const title = html.match(/<title>(.*?)<\/title>/i)?.[1] || '';
    return (
      /验证码中间页|安全验证|captcha|verify/i.test(title) ||
      /captcha\/index\.js|secsdk-captcha|argus-csp-token/i.test(html)
    );
  }

  private generateNonce(): string {
    return this.generateRandomHex(21);
  }

  private generateRandomHex(length: number): string {
    let value = '';
    while (value.length < length) {
      value += Math.random().toString(16).slice(2);
    }
    return value.slice(0, length);
  }

  private assertFallbackCircuitClosed(webRid: string): void {
    const now = Date.now();
    for (const key of [GLOBAL_CIRCUIT_KEY, webRid]) {
      const circuit = DouyinAdapter.circuits.get(key);
      if (!circuit || circuit.retryAt <= now) {
        continue;
      }
      throw new PlatformError(
        `Douyin resolver is cooling down after ${
          circuit.reason
        }; retry in ${Math.ceil((circuit.retryAt - now) / 1000)} seconds.`,
        'douyin',
        DOUYIN_BACKOFF_ERROR_CODE
      );
    }
  }

  private openCircuit(reason: string, webRid: string): number {
    const key = reason === 'captcha' ? GLOBAL_CIRCUIT_KEY : webRid;
    const circuit = DouyinAdapter.circuits.get(key) || {
      failureCount: 0,
      retryAt: 0,
      reason: '',
    };
    circuit.failureCount += 1;
    const delay = Math.min(
      CIRCUIT_BASE_DELAY_MS * 2 ** (circuit.failureCount - 1),
      CIRCUIT_MAX_DELAY_MS
    );
    circuit.retryAt = Date.now() + delay;
    circuit.reason = reason;
    if (
      !DouyinAdapter.circuits.has(key) &&
      DouyinAdapter.circuits.size >= CIRCUIT_MAX_ENTRIES
    ) {
      const oldestKey = Array.from(DouyinAdapter.circuits.keys()).find(
        existingKey => existingKey !== GLOBAL_CIRCUIT_KEY
      );
      if (typeof oldestKey === 'string') {
        DouyinAdapter.circuits.delete(oldestKey);
      }
    }
    DouyinAdapter.circuits.set(key, circuit);
    return delay;
  }

  private resetRoomCircuit(webRid: string): void {
    DouyinAdapter.circuits.delete(webRid);
  }

  private resetFallbackCircuit(webRid: string): void {
    DouyinAdapter.circuits.delete(GLOBAL_CIRCUIT_KEY);
    this.resetRoomCircuit(webRid);
  }

  private resolverMediaCircuitKey(
    webRid: string,
    quality: RecordingQuality
  ): string {
    return `${webRid}:${quality}`;
  }

  private isResolverMediaCircuitOpen(
    webRid: string,
    quality: RecordingQuality
  ): boolean {
    const circuit = DouyinAdapter.resolverMediaCircuits.get(
      this.resolverMediaCircuitKey(webRid, quality)
    );
    return Boolean(circuit && circuit.retryAt > Date.now());
  }

  private openResolverMediaCircuit(
    webRid: string,
    quality: RecordingQuality
  ): number {
    const key = this.resolverMediaCircuitKey(webRid, quality);
    const circuit = DouyinAdapter.resolverMediaCircuits.get(key) || {
      failureCount: 0,
      retryAt: 0,
    };
    circuit.failureCount += 1;
    const delay = Math.min(
      RESOLVER_MEDIA_CIRCUIT_BASE_DELAY_MS * 2 ** (circuit.failureCount - 1),
      RESOLVER_MEDIA_CIRCUIT_MAX_DELAY_MS
    );
    circuit.retryAt = Date.now() + delay;

    if (
      !DouyinAdapter.resolverMediaCircuits.has(key) &&
      DouyinAdapter.resolverMediaCircuits.size >=
        RESOLVER_MEDIA_CIRCUIT_MAX_ENTRIES
    ) {
      const oldestKey = DouyinAdapter.resolverMediaCircuits.keys().next().value;
      if (typeof oldestKey === 'string') {
        DouyinAdapter.resolverMediaCircuits.delete(oldestKey);
      }
    }
    DouyinAdapter.resolverMediaCircuits.set(key, circuit);
    return delay;
  }

  private resetResolverMediaCircuit(
    webRid: string,
    quality: RecordingQuality
  ): void {
    DouyinAdapter.resolverMediaCircuits.delete(
      this.resolverMediaCircuitKey(webRid, quality)
    );
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
    return await this.fetchWithTimeout(url, options, async response => {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.text();
    });
  }

  private async fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
    return await this.fetchWithTimeout(url, options, async response => {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return (await response.json()) as T;
    });
  }

  private async fetchWithTimeout<T>(
    input: string | URL,
    options: RequestInit | undefined,
    consume: (response: Response) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const callerSignal = options?.signal;
    const abortFromCaller = () => controller.abort();
    if (callerSignal?.aborted) {
      controller.abort();
    } else {
      callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(input, {
        ...options,
        signal: controller.signal,
      });
      return await consume(response);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }
}
