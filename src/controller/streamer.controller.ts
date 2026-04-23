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
import { Platform, StorageError, StreamerInfo } from '../interface';
import { PlatformService } from '../service/platform.service';
import { StorageService } from '../service/storage.service';
import {
  InvalidStreamerCoverError,
  StreamerService,
} from '../service/streamer.service';

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

  @Inject()
  storageService: StorageService;

  private async serializeStreamer(streamer: any) {
    return this.streamerService.buildStreamerInfo(streamer);
  }

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
        streamers: await Promise.all(streamers.map(s => this.serializeStreamer(s))),
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

      return await this.serializeStreamer(streamer);
    } catch (error) {
      this.ctx.logger.error('Failed to get streamer', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/streamers/:id/cover - 代理主播封面
   */
  @Get('/:id/cover')
  async getStreamerCover(@Param('id') id: string) {
    try {
      const streamer = await this.streamerService.findById(id);

      if (!streamer || !streamer.coverPath) {
        this.ctx.status = 404;
        return { error: 'Streamer cover not found' };
      }

      const object = await this.storageService.getObjectStream(streamer.coverPath);

      this.ctx.status = 200;
      this.ctx.set('Content-Type', object.contentType || 'application/octet-stream');
      if (object.contentLength !== undefined) {
        this.ctx.set('Content-Length', String(object.contentLength));
      }
      if (object.etag) {
        this.ctx.set('ETag', object.etag);
      }
      if (object.lastModified) {
        this.ctx.set('Last-Modified', object.lastModified.toUTCString());
      }
      this.ctx.set('Cache-Control', 'private, max-age=3600');
      this.ctx.body = object.body;
      return;
    } catch (error) {
      this.ctx.logger.error('Failed to get streamer cover', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof StorageError) {
        const isNotFound =
          /NoSuchKey|NotFound|StatusCode:\s*404/i.test(error.message);
        this.ctx.status = isNotFound ? 404 : 502;
        return { error: error.message };
      }

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

      let coverPath: string | null = null;
      try {
        if (body.coverDataUrl) {
          coverPath = await this.streamerService.uploadCoverDataUrl(
            streamer,
            body.coverDataUrl
          );
          await this.streamerService.update(streamer.id, { coverPath });
        }
      } catch (error) {
        if (coverPath) {
          await this.streamerService.deleteCover(coverPath);
        }
        await this.streamerService.delete(streamer.id);
        throw error;
      }

      this.ctx.status = 201;
      const created = await this.streamerService.findById(streamer.id);
      return created ? await this.serializeStreamer(created) : null;
    } catch (error) {
      if (error instanceof InvalidStreamerCoverError) {
        this.ctx.status = 400;
        return { error: error.message };
      }
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

      let nextCoverPath = streamer.coverPath;
      let uploadedCoverPath: string | null = null;

      if (body.coverDataUrl) {
        uploadedCoverPath = await this.streamerService.uploadCoverDataUrl(
          streamer,
          body.coverDataUrl
        );
        nextCoverPath = uploadedCoverPath;
      } else if (body.removeCover) {
        nextCoverPath = null;
      }

      if (body.coverDataUrl !== undefined || body.removeCover) {
        updateData.coverPath = nextCoverPath;
      }

      try {
        await this.streamerService.update(id, updateData);
      } catch (error) {
        if (uploadedCoverPath) {
          await this.streamerService.deleteCover(uploadedCoverPath);
        }
        throw error;
      }

      if (uploadedCoverPath && streamer.coverPath && streamer.coverPath !== uploadedCoverPath) {
        await this.streamerService.deleteCover(streamer.coverPath);
      } else if (body.removeCover && streamer.coverPath) {
        await this.streamerService.deleteCover(streamer.coverPath);
      }

      // 返回更新后的数据
      const updated = await this.streamerService.findById(id);
      return updated ? await this.serializeStreamer(updated) : null;
    } catch (error) {
      if (error instanceof InvalidStreamerCoverError) {
        this.ctx.status = 400;
        return { error: error.message };
      }
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
      await this.streamerService.deleteCover(streamer.coverPath);

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
        streamer: await this.serializeStreamer(streamer),
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
