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
import { StreamerService } from '../service/streamer.service';

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
  bilibiliSubmissionService: BilibiliSubmissionService;

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
      streamerId?: string;
    }
  ) {
    try {
      // 如果指定了 streamerId, 获取主播的上传设置
      if (body.streamerId) {
        const streamer = await this.streamerService.findById(body.streamerId);
        if (streamer?.uploadSettings) {
          body = {
            ...body,
            ...streamer.uploadSettings,
          };
        }
      }

      // 构建 VideoPart
      const videoPart: VideoPart = {
        title: body.title,
        filename: body.s3Key.split('/').pop() || body.title,
        s3Key: body.s3Key,
        duration: 0,
        size: 0,
      };

      const options: BilibiliUploadOptions = {
        title: body.title,
        description: body.description || '',
        tags: body.tags || [],
        tid: body.tid || 171, // 默认分区
        copyright: 1,
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
    // 常用分区列表（简化版)
    return {
      partitions: [
        {
          id: 1,
          name: '分区',
          children: [
            { id: 24, name: '搞笑' },
            { id: 25, name: '游戏' },
            { id: 47, name: '专栏' },
            { id: 27, name: '音频' },
            { id: 28, name: '娱乐' },
            { id: 29, name: '番剧' },
            { id: 30, name: '影视' },
            { id: 31, name: '纪录片' },
            { id: 207, name: '数码' },
            { id: 208, name: '手游' },
            { id: 229, name: '鬼畜' },
            { id: 217, name: '动物圈' },
            { id: 119, name: '舞蹈' },
            { id: 155, name: '时尚' },
            { id: 202, name: '广告' },
            { id: 138, name: '趣味人文科普' },
          ],
        },
        {
          id: 160,
          name: '生活',
          children: [
            { id: 161, name: '日常' },
            { id: 162, name: '美食圈' },
            { id: 163, name: '动物圈' },
            { id: 164, name: '手办' },
            { id: 165, name: '模玩' },
            { id: 166, name: '萌宠' },
            { id: 167, name: '运动' },
            { id: 168, name: '搞笑' },
            { id: 169, name: '家居房产' },
            { id: 170, name: '手工' },
            { id: 171, name: '绘画' },
            { id: 172, name: '日常' },
          ],
        },
        {
          id: 177,
          name: '知识',
          children: [
            { id: 178, name: '科学科普' },
            { id: 179, name: '社科法律心理' },
            { id: 180, name: '人文历史' },
            { id: 181, name: '财经商业' },
            { id: 182, name: '校园学习' },
            { id: 183, name: '职业职场' },
            { id: 184, name: '设计' },
            { id: 185, name: '技能' },
            { id: 188, name: '演讲' },
          ],
        },
        {
          id: 234,
          name: '科技',
          children: [
            { id: 235, name: '计算机技术' },
            { id: 236, name: '科工机械' },
            { id: 237, name: '前沿科技' },
          ],
        },
        {
          id: 11,
          name: '文章',
          children: [
            { id: 13, name: '漫画' },
            { id: 12, name: '动画' },
            { id: 14, name: '音乐' },
            { id: 15, name: '游戏' },
            { id: 16, name: '真人秀' },
            { id: 17, name: '影视' },
          ],
        },
      ],
    };
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
