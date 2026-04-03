import { Provide, Scope, ScopeEnum } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { Streamer } from '../entity';
import { Platform, StreamerInfo } from '../interface';

@Provide()
@Scope(ScopeEnum.Singleton)
export class StreamerService {
  @InjectEntityModel(Streamer)
  streamerModel: Repository<Streamer>;

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
}
