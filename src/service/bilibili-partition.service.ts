import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { BilibiliCredentialRepository } from '../repository/bilibili-credential.repository';
import {
  BILIBILI_V2_PARTITIONS,
  DEFAULT_BILIBILI_HUMAN_TYPE2,
} from '../config/bilibili-partitions';

interface BilibiliHumanType {
  id: number;
  name: string;
}

export interface BilibiliPartitionGroup {
  id: number;
  name: string;
  children?: BilibiliPartitionGroup[];
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const UPLOAD_REFERER = 'https://member.bilibili.com/platform/upload/video/frame';

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

  async listPartitions(options?: {
    forceRefresh?: boolean;
  }): Promise<BilibiliPartitionGroup[]> {
    if (
      !options?.forceRefresh &&
      this.cache &&
      this.cache.expiresAt > Date.now()
    ) {
      return this.cache.partitions;
    }

    const credential = await this.credentialRepository.findValid();
    if (!credential || new Date() >= credential.expiresAt) {
      return this.useCachedOrDefault(
        'Bilibili credential missing or expired, using fallback partitions'
      );
    }

    try {
      const humanTypes = await this.fetchHumanTypes(
        credential.cookies as Record<string, string>
      );
      const partitions = this.buildPartitions(humanTypes);
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

  buildPartitions(humanTypes: BilibiliHumanType[] = []): BilibiliPartitionGroup[] {
    if (humanTypes.length === 0) {
      return BILIBILI_V2_PARTITIONS;
    }

    const knownTopLevelIds = new Set(BILIBILI_V2_PARTITIONS.map(item => item.id));
    const staticPartitions = new Map(
      BILIBILI_V2_PARTITIONS.map(partition => [partition.id, partition])
    );
    const partitions: BilibiliPartitionGroup[] = [];

    for (const item of humanTypes) {
      const staticPartition = staticPartitions.get(item.id);
      if (staticPartition) {
        partitions.push({
          ...staticPartition,
          name: item.name || staticPartition.name,
        });
        continue;
      }
      if (!knownTopLevelIds.has(item.id)) {
        partitions.push({
          id: item.id,
          name: item.name,
          children: [],
        });
      }
    }

    return partitions;
  }

  resolveHumanType2(humanType2?: number | null): number {
    if (
      typeof humanType2 === 'number' &&
      Number.isInteger(humanType2) &&
      this.containsPartitionId(BILIBILI_V2_PARTITIONS, humanType2)
    ) {
      return humanType2;
    }
    return DEFAULT_BILIBILI_HUMAN_TYPE2;
  }

  private containsPartitionId(
    partitions: BilibiliPartitionGroup[],
    id: number
  ): boolean {
    for (const partition of partitions) {
      if (partition.id === id) {
        return true;
      }
      if (
        partition.children?.length &&
        this.containsPartitionId(partition.children, id)
      ) {
        return true;
      }
    }
    return false;
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
    return BILIBILI_V2_PARTITIONS;
  }
}
