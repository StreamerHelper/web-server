import { Body, Controller, Get, Inject, Param, Post } from '@midwayjs/core';
import { Context } from '@midwayjs/koa';
import {
  DouyinAuthService,
  DouyinBrowserLoginInteraction,
  DouyinCredentialError,
} from '../service/douyin-auth.service';

@Controller('/api/douyin')
export class DouyinController {
  @Inject()
  ctx: Context;

  @Inject()
  douyinAuthService: DouyinAuthService;

  @Get('/auth/status')
  async getAuthStatus() {
    try {
      return await this.douyinAuthService.getStatus();
    } catch (error) {
      this.ctx.logger.error('Failed to get Douyin auth status', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }

  @Post('/auth/cookie')
  async saveCookie(
    @Body()
    body: {
      cookie?: string;
      roomId?: string;
      verify?: boolean;
    }
  ) {
    try {
      return await this.douyinAuthService.saveCookie(body?.cookie || '', {
        roomId: body?.roomId,
        verify: body?.verify,
      });
    } catch (error) {
      this.ctx.status =
        error instanceof DouyinCredentialError ? error.status : 500;
      if (!(error instanceof DouyinCredentialError)) {
        this.ctx.logger.error('Failed to save Douyin Cookie', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to save Douyin Cookie',
      };
    }
  }

  @Post('/auth/browser-login')
  async startBrowserLogin(
    @Body()
    body: {
      roomId?: string;
      fresh?: boolean;
    }
  ) {
    try {
      return await this.douyinAuthService.startBrowserLogin(body?.roomId, {
        fresh: body?.fresh,
      });
    } catch (error) {
      this.ctx.status =
        error instanceof DouyinCredentialError ? error.status : 500;
      if (!(error instanceof DouyinCredentialError)) {
        this.ctx.logger.error('Failed to start Douyin browser login', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to start Douyin browser login',
      };
    }
  }

  @Get('/auth/browser-login/:sessionId')
  async getBrowserLoginStatus(@Param('sessionId') sessionId: string) {
    try {
      return await this.douyinAuthService.getBrowserLoginStatus(sessionId);
    } catch (error) {
      this.ctx.status =
        error instanceof DouyinCredentialError ? error.status : 500;
      if (!(error instanceof DouyinCredentialError)) {
        this.ctx.logger.error('Failed to get Douyin browser login status', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to get Douyin browser login status',
      };
    }
  }

  @Get('/auth/browser-login/:sessionId/screenshot')
  async getBrowserLoginScreenshot(@Param('sessionId') sessionId: string) {
    try {
      const screenshot = await this.douyinAuthService.getBrowserLoginScreenshot(
        sessionId
      );
      this.ctx.status = 200;
      this.ctx.set('Content-Type', 'image/png');
      this.ctx.set('Cache-Control', 'no-store');
      this.ctx.body = screenshot;
      return;
    } catch (error) {
      this.ctx.status =
        error instanceof DouyinCredentialError ? error.status : 500;
      if (!(error instanceof DouyinCredentialError)) {
        this.ctx.logger.error('Failed to get Douyin browser login screenshot', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to get Douyin browser login screenshot',
      };
    }
  }

  @Post('/auth/browser-login/:sessionId/interact')
  async interactWithBrowserLogin(
    @Param('sessionId') sessionId: string,
    @Body() interaction: DouyinBrowserLoginInteraction
  ) {
    try {
      return await this.douyinAuthService.interactWithBrowserLogin(
        sessionId,
        interaction
      );
    } catch (error) {
      this.ctx.status =
        error instanceof DouyinCredentialError ? error.status : 500;
      if (!(error instanceof DouyinCredentialError)) {
        this.ctx.logger.error('Failed to interact with Douyin browser login', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to interact with Douyin browser login',
      };
    }
  }

  @Post('/auth/browser-login/:sessionId/cancel')
  async cancelBrowserLogin(@Param('sessionId') sessionId: string) {
    try {
      await this.douyinAuthService.cancelBrowserLogin(sessionId);
      return { success: true };
    } catch (error) {
      this.ctx.status =
        error instanceof DouyinCredentialError ? error.status : 500;
      if (!(error instanceof DouyinCredentialError)) {
        this.ctx.logger.error('Failed to cancel Douyin browser login', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to cancel Douyin browser login',
      };
    }
  }

  @Post('/auth/verify')
  async verifyProfile(
    @Body()
    body: {
      cookie?: string;
      roomId?: string;
    }
  ) {
    try {
      return await this.douyinAuthService.verifyCookie(
        body?.cookie,
        body?.roomId
      );
    } catch (error) {
      this.ctx.status =
        error instanceof DouyinCredentialError ? error.status : 500;
      if (!(error instanceof DouyinCredentialError)) {
        this.ctx.logger.error('Failed to verify Douyin browser profile', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        ok: false,
        cookieNames: [],
        error:
          error instanceof Error
            ? error.message
            : 'Failed to verify Douyin browser profile',
      };
    }
  }

  @Post('/auth/logout')
  async logout() {
    try {
      await this.douyinAuthService.clear();
      return { success: true };
    } catch (error) {
      this.ctx.logger.error('Failed to clear Douyin browser profile', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.status = 500;
      return { error: 'Internal server error' };
    }
  }
}
