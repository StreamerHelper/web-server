import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { BilibiliCredentialRepository } from '../repository/bilibili-credential.repository';

interface BilibiliHumanType {
  id: number;
  name: string;
}

interface BilibiliPredictedPartition {
  id: number;
  parent: number;
  parent_name: string;
  name: string;
  show?: boolean;
  rank?: number;
  human_type?: {
    id: number;
  } | null;
}

export interface BilibiliPartitionGroup {
  id: number;
  name: string;
  children: Array<{
    id: number;
    name: string;
  }>;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const UPLOAD_REFERER = 'https://member.bilibili.com/platform/upload/video/frame';
const DEFAULT_PARTITIONS: BilibiliPartitionGroup[] = [
  {
    id: 160,
    name: '生活',
    children: [
      { id: 21, name: '日常' },
      { id: 138, name: '搞笑' },
      { id: 250, name: '美食制作' },
      { id: 251, name: '出行' },
      { id: 252, name: '萌宠' },
      { id: 253, name: '手工' },
      { id: 254, name: '绘画' },
      { id: 255, name: '运动' },
    ],
  },
  {
    id: 36,
    name: '知识',
    children: [
      { id: 122, name: '野生技能协会' },
      { id: 201, name: '科学科普' },
      { id: 124, name: '社科·法律·心理' },
      { id: 228, name: '人文历史' },
      { id: 207, name: '财经商业' },
      { id: 208, name: '校园学习' },
      { id: 209, name: '职业职场' },
      { id: 229, name: '设计·创意' },
    ],
  },
  {
    id: 4,
    name: '游戏',
    children: [
      { id: 65, name: '网络游戏' },
      { id: 173, name: '电子竞技' },
      { id: 121, name: 'GMV' },
      { id: 136, name: '音游' },
      { id: 172, name: '手机游戏' },
      { id: 171, name: '单机游戏' },
      { id: 19, name: 'Mugen' },
      { id: 241, name: '桌游棋牌' },
    ],
  },
  {
    id: 5,
    name: '娱乐',
    children: [
      { id: 242, name: '娱乐粉丝创作' },
      { id: 137, name: '明星综合' },
      { id: 240, name: '娱乐' },
    ],
  },
];

@Provide()
@Scope(ScopeEnum.Singleton)
export class BilibiliPartitionService {
  @Logger()
  private logger: ILogger;

  @Inject()
  private credentialRepository: BilibiliCredentialRepository;

  private cache:
    | {
        expiresAt: number;
        partitions: BilibiliPartitionGroup[];
      }
    | null = null;

  async listPartitions(): Promise<BilibiliPartitionGroup[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.partitions;
    }

    const credential = await this.credentialRepository.findValid();
    if (!credential || new Date() >= credential.expiresAt) {
      return this.useCachedOrDefault(
        'Bilibili credential missing or expired, using fallback partitions'
      );
    }

    const cookies = credential.cookies as Record<string, string>;

    try {
      const [humanTypes, predictedPartitions] = await Promise.all([
        this.fetchHumanTypes(cookies),
        this.fetchPredictedPartitions(cookies),
      ]);

      const partitions = this.buildPartitions(humanTypes, predictedPartitions);
      if (partitions.length === 0) {
        return this.useCachedOrDefault(
          'Bilibili partition response was empty, using fallback partitions'
        );
      }

      this.cache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        partitions,
      };

      return partitions;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to refresh bilibili partitions', {
        error: errorMessage,
      });
      return this.useCachedOrDefault(
        'Failed to refresh bilibili partitions, using fallback partitions'
      );
    }
  }

  private async fetchHumanTypes(
    cookies: Record<string, string>
  ): Promise<BilibiliHumanType[]> {
    const url = new URL(
      'https://member.bilibili.com/x/vupre/web/archive/human/type2/list'
    );
    url.searchParams.set('t', String(Date.now()));

    const response = await fetch(url, {
      headers: this.buildHeaders(cookies),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch human partition list: ${response.status}`);
    }

    const result = (await response.json()) as {
      code: number;
      message: string;
      data?: { type_list?: BilibiliHumanType[] };
      type_list?: BilibiliHumanType[];
    };

    if (result.code !== 0) {
      throw new Error(
        `Failed to fetch human partition list: ${result.message || result.code}`
      );
    }

    return result.data?.type_list || result.type_list || [];
  }

  private async fetchPredictedPartitions(
    cookies: Record<string, string>
  ): Promise<BilibiliPredictedPartition[]> {
    const url = new URL(
      'https://member.bilibili.com/x/vupre/web/archive/types/predict'
    );
    url.searchParams.set('ts', String(Date.now()));
    url.searchParams.set('csrf', cookies.bili_jct || '');

    const form = new FormData();
    form.set('filename', '');

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(cookies),
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch predicted partition list: ${response.status}`);
    }

    const result = (await response.json()) as {
      code: number;
      message: string;
      data?: BilibiliPredictedPartition[];
    };

    if (result.code !== 0) {
      throw new Error(
        `Failed to fetch predicted partition list: ${
          result.message || result.code
        }`
      );
    }

    return result.data || [];
  }

  private buildPartitions(
    humanTypes: BilibiliHumanType[],
    predictedPartitions: BilibiliPredictedPartition[]
  ): BilibiliPartitionGroup[] {
    const humanTypeNameMap = new Map(humanTypes.map(item => [item.id, item.name]));
    const groupOrder = new Map(humanTypes.map((item, index) => [item.id, index]));
    const groups = new Map<number, BilibiliPartitionGroup>();
    const seenChildren = new Set<number>();

    for (const item of predictedPartitions) {
      if (item.show === false || seenChildren.has(item.id)) {
        continue;
      }

      const groupId = item.human_type?.id ?? item.parent;
      const groupName =
        humanTypeNameMap.get(groupId) || item.parent_name || '其他';

      if (!groups.has(groupId)) {
        groups.set(groupId, {
          id: groupId,
          name: groupName,
          children: [],
        });
      }

      groups.get(groupId)?.children.push({
        id: item.id,
        name: item.name,
      });
      seenChildren.add(item.id);
    }

    return Array.from(groups.values())
      .filter(group => group.children.length > 0)
      .sort((a, b) => {
        const orderA = groupOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const orderB = groupOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) {
          return orderA - orderB;
        }
        return a.name.localeCompare(b.name, 'zh-CN');
      });
  }

  private buildHeaders(cookies: Record<string, string>): Record<string, string> {
    return {
      Cookie: this.buildCookieHeader(cookies),
      Referer: UPLOAD_REFERER,
      Origin: 'https://member.bilibili.com',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    };
  }

  private buildCookieHeader(cookies: Record<string, string>): string {
    return Object.entries(cookies)
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  private useCachedOrDefault(message: string): BilibiliPartitionGroup[] {
    if (this.cache?.partitions.length) {
      this.logger.warn(message, { source: 'cache' });
      return this.cache.partitions;
    }

    this.logger.warn(message, { source: 'default' });
    return DEFAULT_PARTITIONS;
  }
}
