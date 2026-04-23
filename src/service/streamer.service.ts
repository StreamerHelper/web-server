import { Inject, Provide, Scope, ScopeEnum, Logger, ILogger } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { nanoid } from 'nanoid';
import { Repository } from 'typeorm';
import { Streamer } from '../entity';
import { Platform, StreamerInfo } from '../interface';
import { StorageService } from './storage.service';

const MAX_STREAMER_COVER_BYTES = 5 * 1024 * 1024;
const ALLOWED_STREAMER_COVER_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class InvalidStreamerCoverError extends Error {}

@Provide()
@Scope(ScopeEnum.Singleton)
export class StreamerService {
  @InjectEntityModel(Streamer)
  streamerModel: Repository<Streamer>;

  @Inject()
  storageService: StorageService;

  @Logger()
  private logger: ILogger;

  /**
   * 创建主播
   */
  async create(data: Partial<Streamer>): Promise<Streamer> {
    const streamer = this.streamerModel.create(data);
    return await this.streamerModel.save(streamer);
  }

  /**
   * 根据 streamerId 查找主播
   */
  async findByStreamerId(streamerId: string): Promise<Streamer | null> {
    return await this.streamerModel.findOne({ where: { streamerId } });
  }

  /**
   * 根据 ID 查找主播
   */
  async findById(id: string): Promise<Streamer | null> {
    return await this.streamerModel.findOne({ where: { id } });
  }

  /**
   * 查找所有活跃主播
   */
  async findActive(): Promise<Streamer[]> {
    return await this.streamerModel.find({
      where: { isActive: true },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * 根据平台查找主播
   */
  async findByPlatform(platform: Platform): Promise<Streamer[]> {
    return await this.streamerModel.find({
      where: { platform, isActive: true },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * 查找所有主播
   */
  async findAll(): Promise<Streamer[]> {
    return await this.streamerModel.find({
      order: { createdAt: 'ASC' },
    });
  }

  async findByStreamerIds(streamerIds: string[]): Promise<Streamer[]> {
    if (streamerIds.length === 0) {
      return [];
    }

    return await this.streamerModel
      .createQueryBuilder('streamer')
      .where('streamer.streamerId IN (:...streamerIds)', { streamerIds })
      .getMany();
  }

  /**
   * 更新主播信息
   */
  async update(id: string, data: Partial<Streamer>): Promise<void> {
    await this.streamerModel.update({ id }, data);
  }

  /**
   * 更新主播状态
   */
  async updateStatus(id: string, isActive: boolean): Promise<void> {
    await this.streamerModel.update({ id }, { isActive });
  }

  /**
   * 更新最后检查时间（使用原生 SQL，不触发 updated_at 更新）
   */
  async updateLastCheckTime(id: string): Promise<void> {
    await this.streamerModel
      .createQueryBuilder()
      .update(Streamer)
      .set({ lastCheckTime: () => 'NOW()' })
      .where('id = :id', { id })
      .execute();
  }

  /**
   * 更新最后直播时间
   */
  async updateLastLiveTime(id: string): Promise<void> {
    await this.streamerModel.update({ id }, { lastLiveTime: new Date() });
  }

  /**
   * 删除主播
   */
  async delete(id: string): Promise<void> {
    await this.streamerModel.delete({ id });
  }

  async buildStreamerInfo(streamer: Streamer): Promise<StreamerInfo> {
    const info = streamer.toInfo();
    return {
      ...info,
      coverUrl: await this.getCoverUrl(streamer.id, streamer.coverPath),
    };
  }

  async uploadCoverDataUrl(
    streamer: Pick<Streamer, 'id' | 'streamerId'>,
    coverDataUrl: string
  ): Promise<string> {
    const { buffer, mimeType, extension } = this.parseCoverDataUrl(coverDataUrl);
    const key = `streamers/${streamer.id || streamer.streamerId}/cover/${Date.now()}-${nanoid(10)}.${extension}`;
    await this.storageService.upload(key, buffer, mimeType);
    return key;
  }

  async deleteCover(coverPath?: string | null): Promise<void> {
    if (!coverPath) {
      return;
    }

    try {
      await this.storageService.delete(coverPath);
    } catch (error) {
      this.logger.warn('Failed to delete streamer cover from storage', {
        coverPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getCoverUrl(
    streamerId: string,
    coverPath?: string | null
  ): Promise<string | null> {
    if (!streamerId || !coverPath) {
      return null;
    }

    return `/api/streamers/${streamerId}/cover`;
  }

  /**
   * 批量创建或更新主播
   */
  async upsert(streamers: StreamerInfo[]): Promise<void> {
    for (const info of streamers) {
      const existing = await this.findByStreamerId(info.streamerId);
      if (existing) {
        await this.streamerModel.update(
          { id: existing.id },
          {
            name: info.name,
            roomId: info.roomId,
            recordSettings: info.recordSettings,
            uploadSettings: info.uploadSettings,
          }
        );
      } else {
        await this.create({
          streamerId: info.streamerId,
          name: info.name,
          platform: info.platform,
          roomId: info.roomId,
          isActive: info.isActive ?? true,
          recordSettings: info.recordSettings,
          uploadSettings: info.uploadSettings,
        });
      }
    }
  }

  /**
   * 获取主播统计
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    byPlatform: Record<Platform, number>;
  }> {
    const [total, active, bilibiliCount, douyuCount, huyaCount] =
      await Promise.all([
        this.streamerModel.count(),
        this.streamerModel.count({ where: { isActive: true } }),
        this.streamerModel.count({ where: { platform: 'bilibili' } }),
        this.streamerModel.count({ where: { platform: 'douyu' } }),
        this.streamerModel.count({ where: { platform: 'huya' } }),
      ]);

    return {
      total,
      active,
      byPlatform: {
        bilibili: bilibiliCount,
        douyu: douyuCount,
        huya: huyaCount,
      },
    };
  }

  private parseCoverDataUrl(coverDataUrl: string): {
    buffer: Buffer;
    mimeType: string;
    extension: string;
  } {
    const match = coverDataUrl.match(
      /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/
    );
    if (!match) {
      throw new InvalidStreamerCoverError('Invalid cover image payload');
    }

    const mimeType = match[1].toLowerCase();
    const extension = ALLOWED_STREAMER_COVER_TYPES[mimeType];
    if (!extension) {
      throw new InvalidStreamerCoverError(
        'Unsupported cover image type. Please use JPG, PNG, or WebP.'
      );
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) {
      throw new InvalidStreamerCoverError('Cover image is empty');
    }

    if (buffer.length > MAX_STREAMER_COVER_BYTES) {
      throw new InvalidStreamerCoverError(
        'Cover image is too large. Please keep it under 5MB.'
      );
    }

    return { buffer, mimeType, extension };
  }
}
