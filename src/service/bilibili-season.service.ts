import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { BilibiliCredential } from '../interface';
import { BilibiliCredentialRepository } from '../repository/bilibili-credential.repository';
import { BilibiliUploadService } from './bilibili-upload.service';

const CREATIVE_REFERER =
  'https://member.bilibili.com/platform/upload/video/frame';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const VIDEO_INFO_RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000];

export interface BilibiliSeasonSection {
  id: number;
  seasonId: number;
  title: string;
  order?: number;
  epCount?: number;
}

export interface BilibiliSeason {
  id: number;
  title: string;
  desc?: string;
  cover?: string;
  state?: number;
  epCount?: number;
  sections: BilibiliSeasonSection[];
}

export interface BilibiliSeasonListResult {
  seasons: BilibiliSeason[];
  total: number;
}

export interface CreateBilibiliSeasonInput {
  title: string;
  desc?: string;
  cover?: string;
}

export interface BilibiliSeasonEpisodeResult {
  added: boolean;
  alreadyExists: boolean;
  episodeId: number | null;
  aid: number;
  cid: number;
  title: string;
  sectionId: number;
}

interface BilibiliApiResponse<T> {
  code?: number;
  message?: string;
  msg?: string;
  data?: T;
}

interface RawSeasonListData {
  seasons?: RawSeasonItem[];
  total?: number;
}

interface RawSeasonItem {
  season?: RawSeason;
  sections?: { sections?: RawSection[] };
}

interface RawSeason {
  id?: number;
  title?: string;
  desc?: string;
  cover?: string;
  state?: number;
  ep_num?: number;
  epCount?: number;
}

interface RawSection {
  id?: number;
  seasonId?: number;
  title?: string;
  order?: number;
  epCount?: number;
}

interface RawVideoInfo {
  title?: string;
  pages?: Array<{ cid?: number }>;
}

interface RawSeasonSectionData {
  section?: RawSection;
  episodes?: RawEpisode[];
}

interface RawEpisode {
  id?: number;
  aid?: number;
  cid?: number;
  title?: string;
  videoTitle?: string;
  archiveTitle?: string;
}

@Provide()
@Scope(ScopeEnum.Singleton)
export class BilibiliSeasonService {
  private readonly videoInfoRetryDelays = VIDEO_INFO_RETRY_DELAYS;

  @Logger()
  private logger: ILogger;

  @Inject()
  private credentialRepository: BilibiliCredentialRepository;

  @Inject()
  private bilibiliUploadService: BilibiliUploadService;

  async listSeasons(options?: {
    pn?: number;
    ps?: number;
    forceRefresh?: boolean;
  }): Promise<BilibiliSeasonListResult> {
    const credential = await this.getValidCredential();
    const url = new URL('https://member.bilibili.com/x2/creative/web/seasons');
    url.searchParams.set('pn', String(options?.pn || 1));
    url.searchParams.set('ps', String(options?.ps || 50));
    url.searchParams.set('order', 'mtime');
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('draft', '1');
    if (options?.forceRefresh) {
      url.searchParams.set('ts', String(Date.now()));
    }

    const result = await this.fetchJson<RawSeasonListData>(url, {
      headers: this.buildHeaders(credential.cookies),
    });

    const data = this.expectSuccess(result, '获取B站合集列表');
    return {
      seasons: (data.seasons || [])
        .map(item => this.normalizeSeason(item))
        .filter((item): item is BilibiliSeason => item !== null),
      total: data.total || 0,
    };
  }

  async createSeason(
    input: CreateBilibiliSeasonInput
  ): Promise<BilibiliSeason> {
    const title = input.title.trim();
    if (!title) {
      throw new Error('Bilibili season title is required');
    }

    const cover = await this.bilibiliUploadService.resolveCoverForCreative(
      input.cover
    );
    if (!cover) {
      throw new Error('Bilibili season cover is required');
    }

    const credential = await this.getValidCredential();
    const body = new URLSearchParams({
      title,
      desc: input.desc?.trim() || '',
      cover,
      season_price: '0',
      csrf: credential.cookies.bili_jct,
    });

    const result = await this.fetchJson<number>(
      new URL('https://member.bilibili.com/x2/creative/web/season/add'),
      {
        method: 'POST',
        headers: {
          ...this.buildHeaders(credential.cookies),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }
    );
    const seasonId = Number(this.expectSuccess(result, '创建B站合集'));
    if (!Number.isFinite(seasonId) || seasonId <= 0) {
      throw new Error('创建B站合集失败: 未返回合集 ID');
    }

    const createdSeason = await this.findSeasonById(seasonId);
    return (
      createdSeason || {
        id: seasonId,
        title,
        desc: input.desc?.trim() || '',
        cover,
        sections: [],
      }
    );
  }

  async addVideoToSeason(input: {
    aid: number;
    sectionId: number;
    title?: string;
    cid?: number;
  }): Promise<BilibiliSeasonEpisodeResult> {
    const aid = Number(input.aid);
    const sectionId = Number(input.sectionId);
    if (!Number.isFinite(aid) || aid <= 0) {
      throw new Error(`Invalid Bilibili aid: ${input.aid}`);
    }
    if (!Number.isFinite(sectionId) || sectionId <= 0) {
      throw new Error(`Invalid Bilibili section id: ${input.sectionId}`);
    }

    const credential = await this.getValidCredential();
    const existingEpisode = await this.findEpisodeByAid(
      sectionId,
      aid,
      credential.cookies
    );
    if (existingEpisode) {
      return this.buildEpisodeResult({
        added: false,
        alreadyExists: true,
        episode: existingEpisode,
        aid,
        sectionId,
        fallbackCid: input.cid,
        fallbackTitle: input.title,
      });
    }

    const inputCid = Number(input.cid || 0);
    let cid = Number.isFinite(inputCid) ? inputCid : 0;
    let title = (input.title || '').trim();

    if (!cid || !title) {
      const videoInfo = await this.getVideoInfoWithRetry(
        aid,
        credential.cookies
      );
      cid = Number(cid || videoInfo.pages?.[0]?.cid || 0);
      title = (title || videoInfo.title || '').trim();
    }

    if (!Number.isFinite(cid) || cid <= 0) {
      throw new Error(`Failed to resolve cid for Bilibili aid ${aid}`);
    }
    if (!title) {
      throw new Error(`Failed to resolve title for Bilibili aid ${aid}`);
    }

    const url = new URL(
      'https://member.bilibili.com/x2/creative/web/season/section/episodes/add'
    );
    url.searchParams.set('csrf', credential.cookies.bili_jct);

    const result = await this.fetchJson<unknown>(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(credential.cookies),
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        sectionId,
        episodes: [
          {
            aid,
            cid,
            title,
            charging_pay: 0,
          },
        ],
      }),
    });
    this.expectSuccess(result, '添加视频到B站合集');

    const episode = await this.findEpisodeByAid(
      sectionId,
      aid,
      credential.cookies
    );
    return {
      added: true,
      alreadyExists: false,
      episodeId: episode?.id || null,
      aid,
      cid,
      title,
      sectionId,
    };
  }

  private async getVideoInfoWithRetry(
    aid: number,
    cookies: BilibiliCredential['cookies']
  ): Promise<RawVideoInfo> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.videoInfoRetryDelays.length; attempt++) {
      if (attempt > 0) {
        const delayMs = this.videoInfoRetryDelays[attempt - 1];
        this.logger.warn('Bilibili video info is not ready, retrying later', {
          aid,
          attempt: attempt + 1,
          delayMs,
          error:
            lastError instanceof Error ? lastError.message : String(lastError),
        });
        await this.sleep(delayMs);
      }

      try {
        return await this.getVideoInfo(aid, cookies);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  private async getVideoInfo(
    aid: number,
    cookies: BilibiliCredential['cookies']
  ): Promise<RawVideoInfo> {
    const url = new URL('https://api.bilibili.com/x/web-interface/view');
    url.searchParams.set('aid', String(aid));

    const result = await this.fetchJson<RawVideoInfo>(url, {
      headers: this.buildHeaders(
        cookies,
        `https://www.bilibili.com/video/av${aid}`
      ),
    });
    return this.expectSuccess(result, '获取B站视频信息');
  }

  private async sleep(delayMs: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  private async findSeasonById(
    seasonId: number
  ): Promise<BilibiliSeason | null> {
    const firstPage = await this.listSeasons({
      pn: 1,
      ps: 50,
      forceRefresh: true,
    });
    const firstPageSeason = firstPage.seasons.find(
      season => season.id === seasonId
    );
    if (firstPageSeason) {
      return firstPageSeason;
    }

    const totalPages = Math.ceil(firstPage.total / 50);
    for (let pn = 2; pn <= totalPages; pn++) {
      const page = await this.listSeasons({ pn, ps: 50, forceRefresh: true });
      const season = page.seasons.find(item => item.id === seasonId);
      if (season) {
        return season;
      }
    }

    return null;
  }

  private async findEpisodeByAid(
    sectionId: number,
    aid: number,
    cookies: BilibiliCredential['cookies']
  ): Promise<RawEpisode | null> {
    const url = new URL(
      'https://member.bilibili.com/x2/creative/web/season/section'
    );
    url.searchParams.set('id', String(sectionId));

    try {
      const result = await this.fetchJson<RawSeasonSectionData>(url, {
        headers: this.buildHeaders(cookies),
      });
      const data = this.expectSuccess(result, '获取B站合集小节视频');
      return (
        (data.episodes || []).find(episode => Number(episode.aid) === aid) ||
        null
      );
    } catch (error) {
      this.logger.warn('Failed to inspect bilibili season section', {
        sectionId,
        aid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildEpisodeResult(input: {
    added: boolean;
    alreadyExists: boolean;
    episode: RawEpisode;
    aid: number;
    sectionId: number;
    fallbackCid?: number;
    fallbackTitle?: string;
  }): BilibiliSeasonEpisodeResult {
    return {
      added: input.added,
      alreadyExists: input.alreadyExists,
      episodeId: input.episode.id || null,
      aid: input.aid,
      cid: Number(input.episode.cid || input.fallbackCid || 0),
      title:
        input.episode.title ||
        input.episode.videoTitle ||
        input.episode.archiveTitle ||
        input.fallbackTitle ||
        '',
      sectionId: input.sectionId,
    };
  }

  private async getValidCredential(): Promise<BilibiliCredential> {
    const credential = await this.credentialRepository.findValid();
    if (!credential) {
      throw new Error('Bilibili not authenticated. Please login first.');
    }
    if (new Date() >= credential.expiresAt) {
      throw new Error('Bilibili credential expired. Please login again.');
    }
    return credential;
  }

  private async fetchJson<T>(
    url: URL,
    init: RequestInit
  ): Promise<BilibiliApiResponse<T>> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`Bilibili API HTTP ${response.status}: ${url.pathname}`);
    }
    return (await response.json()) as BilibiliApiResponse<T>;
  }

  private expectSuccess<T>(result: BilibiliApiResponse<T>, action: string): T {
    if (result.code !== 0) {
      throw new Error(
        `${action}失败: ${result.message || result.msg || result.code}`
      );
    }
    return (result.data || {}) as T;
  }

  private normalizeSeason(item: RawSeasonItem): BilibiliSeason | null {
    const season = item.season;
    if (!season?.id) {
      return null;
    }
    const sections = (item.sections?.sections || [])
      .filter(section => section.id)
      .map(section => ({
        id: Number(section.id),
        seasonId: Number(section.seasonId || season.id),
        title: section.title || '正片',
        order: section.order,
        epCount: section.epCount,
      }));

    return {
      id: Number(season.id),
      title: season.title || `合集 ${season.id}`,
      desc: season.desc,
      cover: season.cover,
      state: season.state,
      epCount: season.ep_num || season.epCount,
      sections,
    };
  }

  private buildHeaders(
    cookies: BilibiliCredential['cookies'],
    referer = CREATIVE_REFERER
  ): Record<string, string> {
    return {
      Cookie: this.buildCookieHeader(cookies),
      Referer: referer,
      Origin: 'https://member.bilibili.com',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'User-Agent': USER_AGENT,
    };
  }

  private buildCookieHeader(cookies: Record<string, string>): string {
    return Object.entries(cookies)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }
}
