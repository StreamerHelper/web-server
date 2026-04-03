import {
  App,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@midwayjs/core';
import { Application, Context } from '@midwayjs/koa';
import { Platform, StreamerInfo } from '../interface';
import { PlatformService } from '../service/platform.service';
import { StreamerService } from '../service/streamer.service';

@Controller('/api/streamers')
export class StreamerController {
  @Inject()
  ctx: Context;

  @App()
  app: Application;

  @Inject()
  streamerService: StreamerService;

  @Inject()
  platformService: PlatformService;

  /**
   * GET /api/streamers - 获取主播列表
   */
  @Get('/')
  async listStreamers(@Query('platform') platform?: Platform) {
    try {
      let streamers;

      if (platform) {
        streamers = await this.streamerService.findByPlatform(platform);
      } else {
        streamers = await this.streamerService.findAll();
      }

      return {
        streamers: streamers.map(s => s.toInfo()),
        total: streamers.length,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to list streamers', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/streamers/stats - 获取主播统计
   */
  @Get('/stats')
  async getStats() {
    try {
      const stats = await this.streamerService.getStats();
      return stats;
    } catch (error) {
      this.ctx.logger.error('Failed to get streamer stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/streamers/:id - 获取主播详情
   */
  @Get('/:id')
  async getStreamer(@Param('id') id: string) {
    try {
      const streamer = await this.streamerService.findById(id);

      if (!streamer) {
        this.ctx.status = 404;
        return { error: 'Streamer not found' };
      }

      return streamer.toInfo();
    } catch (error) {
      this.ctx.logger.error('Failed to get streamer', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/streamers - 添加主播
   */
  @Post('/')
  async addStreamer(@Body() body: StreamerInfo) {
    try {
      // 验证输入
      if (!body.streamerId || !body.platform || !body.roomId) {
        this.ctx.status = 400;
        return {
          error: 'Missing required fields: streamerId, platform, roomId',
        };
      }

      // 验证主播 ID 是否有效
      const isValid = await this.platformService.validateStreamerId(
        body.platform,
        body.streamerId
      );
      if (!isValid) {
        this.ctx.status = 400;
        return { error: 'Invalid streamer ID for this platform' };
      }

      // 创建主播
      const streamer = await this.streamerService.create({
        streamerId: body.streamerId,
        name: body.name,
        platform: body.platform,
        roomId: body.roomId,
        isActive: body.isActive ?? true,
        recordSettings: body.recordSettings,
        uploadSettings: body.uploadSettings,
      });

      this.ctx.status = 201;
      return streamer.toInfo();
    } catch (error) {
      this.ctx.logger.error('Failed to add streamer', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * PUT /api/streamers/:id - 更新主播信息
   */
  @Put('/:id')
  async updateStreamer(
    @Param('id') id: string,
    @Body() body: Partial<StreamerInfo>
  ) {
    try {
      const streamer = await this.streamerService.findById(id);

      if (!streamer) {
        this.ctx.status = 404;
        return { error: 'Streamer not found' };
      }

      // 更新字段
      const updateData: any = {};
      if (body.name !== undefined) updateData.name = body.name;
      if (body.roomId !== undefined) updateData.roomId = body.roomId;
      if (body.isActive !== undefined) updateData.isActive = body.isActive;
      if (body.recordSettings !== undefined)
        updateData.recordSettings = body.recordSettings;
      if (body.uploadSettings !== undefined)
        updateData.uploadSettings = body.uploadSettings;

      await this.streamerService.update(id, updateData);

      // 返回更新后的数据
      const updated = await this.streamerService.findById(id);
      return updated?.toInfo();
    } catch (error) {
      this.ctx.logger.error('Failed to update streamer', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/streamers/:id/delete - 删除主播
   */
  @Post('/:id/delete')
  async deleteStreamer(@Param('id') id: string) {
    try {
      const streamer = await this.streamerService.findById(id);

      if (!streamer) {
        this.ctx.status = 404;
        return { error: 'Streamer not found' };
      }

      await this.streamerService.delete(id);

      return { success: true, message: 'Streamer deleted' };
    } catch (error) {
      this.ctx.logger.error('Failed to delete streamer', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/streamers/:id/check - 检查主播直播状态
   */
  @Post('/:id/check')
  async checkStatus(@Param('id') id: string) {
    try {
      const streamer = await this.streamerService.findById(id);

      if (!streamer) {
        this.ctx.status = 404;
        return { error: 'Streamer not found' };
      }

      // 更新最后检查时间
      await this.streamerService.updateLastCheckTime(streamer.id);

      // 获取直播状态
      const status = await this.platformService.checkLiveStatus(
        streamer.platform as Platform,
        streamer.streamerId
      );

      // 如果正在直播，更新最后直播时间
      if (status.isLive) {
        await this.streamerService.updateLastLiveTime(streamer.id);
      }

      return {
        streamer: streamer.toInfo(),
        status,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to check streamer status', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/streamers/batch - 批量添加主播
   */
  @Post('/batch')
  async addStreamers(@Body() body: { streamers: StreamerInfo[] }) {
    try {
      if (!Array.isArray(body.streamers) || body.streamers.length === 0) {
        this.ctx.status = 400;
        return { error: 'Invalid input: streamers must be a non-empty array' };
      }

      await this.streamerService.upsert(body.streamers);

      this.ctx.status = 201;
      return {
        success: true,
        count: body.streamers.length,
        message: 'Streamers added/updated',
      };
    } catch (error) {
      this.ctx.logger.error('Failed to add streamers', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }
}
