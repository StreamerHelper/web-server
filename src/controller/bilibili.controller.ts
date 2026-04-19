import { Framework } from '@midwayjs/bullmq';
import { Body, Controller, Get, Inject, Post, Query } from '@midwayjs/core';
import { Context } from '@midwayjs/koa';
import { SubmissionStatus } from '../entity/bilibili-submission.entity';
import { BilibiliCredentialRepository } from '../repository/bilibili-credential.repository';
import { BilibiliAuthService } from '../service/bilibili-auth.service';
import {
  BilibiliSubmissionService,
  CreateSubmissionInput,
} from '../service/bilibili-submission.service';
import {
  BilibiliUploadOptions,
  BilibiliUploadService,
  VideoPart,
} from '../service/bilibili-upload.service';
import { JobService } from '../service/job.service';
import { BilibiliPartitionService } from '../service/bilibili-partition.service';
import { SubmissionTemplateService } from '../service/submission-template.service';
import { StreamerService } from '../service/streamer.service';
import { buildPlatformRoomUrl } from '../utils/platform-room-url';

@Controller('/api/bilibili')
export class BilibiliController {
  @Inject()
  ctx: Context;

  @Inject()
  bilibiliAuthService: BilibiliAuthService;

  @Inject()
  bilibiliUploadService: BilibiliUploadService;

  @Inject()
  bilibiliCredentialRepository: BilibiliCredentialRepository;

  @Inject()
  streamerService: StreamerService;

  @Inject()
  jobService: JobService;

  @Inject()
  submissionTemplateService: SubmissionTemplateService;

  @Inject()
  bilibiliSubmissionService: BilibiliSubmissionService;

  @Inject()
  bilibiliPartitionService: BilibiliPartitionService;

  @Inject()
  bullFramework: Framework;

  @Get('/auth/status')
  async getAuthStatus() {
    try {
      const credential = await this.bilibiliCredentialRepository.findValid();

      if (!credential) {
        return {
          isAuthenticated: false,
        };
      }

      try {
        const accountInfo = await this.bilibiliAuthService.getAccountInfo(
          credential.cookies
        );

        return {
          isAuthenticated: true,
          mid: credential.mid,
          expiresAt: credential.expiresAt,
          account: {
            mid: accountInfo.mid,
            name: accountInfo.name,
            face: accountInfo.face,
            sign: accountInfo.sign,
            level: accountInfo.level,
            vipType: accountInfo.vipType,
            vipStatus: accountInfo.vipStatus,
          },
        };
      } catch (error) {
        this.ctx.logger.warn(
          'Failed to get account info, token may be expired',
          {
            error: error instanceof Error ? error.message : String(error),
          }
        );
        return {
          isAuthenticated: true,
          mid: credential.mid,
          expiresAt: credential.expiresAt,
          account: null,
          tokenExpired: true,
        };
      }
    } catch (error) {
      this.ctx.logger.error('Failed to get auth status', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  @Post('/auth/qrcode')
  async getQRCode() {
    try {
      const result = await this.bilibiliAuthService.getQRCode();

      return {
        authCode: result.authCode,
        url: result.url,
        expiresIn: 300, // 5分钟有效
      };
    } catch (error) {
      this.ctx.logger.error('Failed to get QR code', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return {
        error:
          error instanceof Error ? error.message : 'Failed to generate QR code',
      };
    }
  }

  /**
   * POST /api/bilibili/auth/poll - 轮询登录状态
   */
  @Post('/auth/poll')
  async pollLogin(@Body() body: { authCode: string }) {
    try {
      const result = await this.bilibiliAuthService.pollQRCode(body.authCode);

      if (result.status === 'success' && result.tokenInfo) {
        // 从 cookieInfo 中提取 cookie 值
        const cookies: {
          SESSDATA: string;
          bili_jct: string;
          Dedeuserid: string;
        } = {
          SESSDATA: '',
          bili_jct: '',
          Dedeuserid: '',
        };

        if (result.cookieInfo?.cookies) {
          for (const cookie of result.cookieInfo.cookies) {
            if (cookie.name === 'SESSDATA') {
              cookies.SESSDATA = cookie.value;
            } else if (cookie.name === 'bili_jct') {
              cookies.bili_jct = cookie.value;
            } else if (cookie.name === 'Dedeuserid') {
              cookies.Dedeuserid = cookie.value;
            }
          }
        }

        // 保存凭证到数据库
        await this.bilibiliCredentialRepository.clear();
        await this.bilibiliCredentialRepository.save({
          accessToken: result.tokenInfo.accessToken,
          refreshToken: result.tokenInfo.refreshToken,
          mid: result.tokenInfo.mid,
          expiresAt: new Date(Date.now() + result.tokenInfo.expiresIn * 1000),
          cookies,
        });

        return {
          status: 'success',
          mid: result.tokenInfo.mid,
        };
      } else if (result.status === 'expired') {
        return {
          status: 'expired',
          message: 'QR code has expired',
        };
      } else {
        return {
          status: 'waiting',
          message: 'Waiting for scan',
        };
      }
    } catch (error) {
      this.ctx.logger.error('Failed to poll login', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to poll login status',
      };
    }
  }

  /**
   * POST /api/bilibili/auth/logout - 登出
   */
  @Post('/auth/logout')
  async logout() {
    try {
      await this.bilibiliCredentialRepository.clear();
      return { success: true };
    } catch (error) {
      this.ctx.logger.error('Failed to logout', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * POST /api/bilibili/upload/video - 上传视频到 B站
   */
  @Post('/upload/video')
  async uploadVideo(
    @Body()
    body: {
      s3Key: string;
      title: string;
      description?: string;
      tags?: string[];
      tid?: number;
      cover?: string;
      source?: string;
      jobId?: string;
      streamerId?: string;
    }
  ) {
    try {
      let job = null;
      if (body.jobId) {
        job = await this.jobService.findByJobId(body.jobId);
      }

      let streamer = null;
      if (body.streamerId) {
        streamer =
          (await this.streamerService.findById(body.streamerId)) ||
          (await this.streamerService.findByStreamerId(body.streamerId));
      }

      const uploadSettings = streamer?.uploadSettings || {};
      const title = this.submissionTemplateService.resolveTitle(
        body.title || uploadSettings.title,
        {
          streamerName: job?.streamerName || streamer?.name,
          startedAt: job?.startTime || job?.createdAt || Date.now(),
        }
      );
      const description = body.description ?? uploadSettings.description ?? '';
      const tags = body.tags ?? uploadSettings.tags ?? [];
      const tid = this.submissionTemplateService.resolveTid(
        body.tid ?? uploadSettings.tid
      );
      const cover = body.cover ?? job?.coverPath ?? streamer?.coverPath ?? undefined;
      const source =
        body.source?.trim() ||
        buildPlatformRoomUrl(job?.platform, job?.roomId) ||
        buildPlatformRoomUrl(streamer?.platform, streamer?.roomId);

      // 构建 VideoPart
      const videoPart: VideoPart = {
        title,
        filename: body.s3Key.split('/').pop() || title,
        s3Key: body.s3Key,
        duration: 0,
        size: 0,
      };

      const options: BilibiliUploadOptions = {
        title,
        description,
        tags,
        tid,
        cover,
        copyright: 2,
        source,
      };

      const result = await this.bilibiliUploadService.upload(
        [videoPart],
        options
      );

      return {
        bvid: result.bvid,
        avid: result.avid,
        url: `https://www.bilibili.com/video/${result.bvid}`,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to upload video', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return {
        error: error instanceof Error ? error.message : 'Internal server error',
      };
    }
  }

  /**
   * GET /api/bilibili/upload/partitions - 获取分区列表
   */
  @Get('/upload/partitions')
  async getPartitions() {
    try {
      const partitions = await this.bilibiliPartitionService.listPartitions();
      return { partitions };
    } catch (error) {
      this.ctx.logger.error('Failed to get bilibili partitions', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Failed to get bilibili partitions' };
    }
  }

  // ==================== 投稿相关 API ====================

  /**
   * POST /api/bilibili/submission - 创建投稿任务
   *
   * 选中某次录制，创建B站投稿任务
   */
  @Post('/submission')
  async createSubmission(@Body() body: CreateSubmissionInput) {
    try {
      // 检查是否已登录
      const credential = await this.bilibiliCredentialRepository.findValid();
      if (!credential) {
        this.ctx.status = 401;
        return { error: 'Bilibili not authenticated. Please login first.' };
      }

      // 创建投稿记录
      const submission = await this.bilibiliSubmissionService.createSubmission(
        body
      );

      // 派发任务到队列
      const queue = this.bullFramework.getQueue('bilibili-submission');
      if (queue) {
        await queue.addJobToQueue({
          submissionId: submission.id,
        });
      }

      return {
        id: submission.id,
        jobId: submission.jobId,
        title: submission.title,
        status: submission.status,
        totalParts: submission.totalParts,
        createdAt: submission.createdAt,
      };
    } catch (error) {
      this.ctx.logger.error('Failed to create submission', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return {
        error: error instanceof Error ? error.message : 'Internal server error',
      };
    }
  }

  /**
   * GET /api/bilibili/submission/:id - 获取投稿详情
   */
  @Get('/submission/:id')
  async getSubmission() {
    try {
      const id = this.ctx.params.id;
      const submission = await this.bilibiliSubmissionService.getSubmission(id);

      if (!submission) {
        this.ctx.status = 404;
        return { error: 'Submission not found' };
      }

      return submission;
    } catch (error) {
      this.ctx.logger.error('Failed to get submission', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/bilibili/submission - 获取投稿列表
   */
  @Get('/submission')
  async listSubmissions(
    @Query()
    query: {
      page?: number;
      pageSize?: number;
      jobId?: string;
      status?: SubmissionStatus;
    }
  ) {
    try {
      const result = await this.bilibiliSubmissionService.listSubmissions({
        page: query.page ? parseInt(String(query.page)) : 1,
        pageSize: query.pageSize ? parseInt(String(query.pageSize)) : 20,
        jobId: query.jobId,
        status: query.status,
      });

      return result;
    } catch (error) {
      this.ctx.logger.error('Failed to list submissions', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  /**
   * GET /api/bilibili/submission/job/:jobId - 获取某次录制的投稿列表
   */
  @Get('/submission/job/:jobId')
  async getSubmissionsByJobId() {
    try {
      const jobId = this.ctx.params.jobId;
      const submissions =
        await this.bilibiliSubmissionService.getSubmissionsByJobId(jobId);

      return { items: submissions };
    } catch (error) {
      this.ctx.logger.error('Failed to get submissions by job id', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }
}
