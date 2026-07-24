import * as bullBoard from '@midwayjs/bull-board';
import * as bullmq from '@midwayjs/bullmq';
import { Framework } from '@midwayjs/bullmq';
import { Configuration, ILogger, Inject, Logger } from '@midwayjs/core';
import * as koa from '@midwayjs/koa';
import * as orm from '@midwayjs/typeorm';
import * as validate from '@midwayjs/validate';
import { join } from 'path';
import { BilibiliSubmissionRecoveryService } from './service/bilibili-submission-recovery.service';
import { NoticeService } from './service/notice/notice.service';

@Configuration({
  imports: [koa, validate, bullmq, bullBoard, orm],
  importConfigs: [join(__dirname, './config')],
})
export class MainConfiguration {
  @Inject()
  bullFramework: Framework;

  @Inject()
  bilibiliSubmissionRecoveryService: BilibiliSubmissionRecoveryService;

  @Inject()
  noticeService: NoticeService;

  @Logger()
  logger: ILogger;

  async onServerReady() {
    this.noticeService.start();
    this.setupGlobalErrorHandlers();

    const pollerQueue = this.bullFramework.getQueue('poller');
    await pollerQueue?.addJobToQueue(null);

    await this.bilibiliSubmissionRecoveryService
      .resumeRecoverableSubmissions()
      .catch(error => {
        this.logger.error('Failed to resume bilibili submissions', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async onStop() {
    await this.noticeService.stop();
  }

  private setupGlobalErrorHandlers(): void {
    process.on('unhandledRejection', (reason: unknown) => {
      this.logger.error('Unhandled Promise Rejection', { reason });
    });

    process.on('uncaughtException', (error: Error) => {
      this.logger.error('Uncaught Exception', { error });
      // process.exit(1);
    });

    process.on('warning', warning => {
      this.logger.warn('Process Warning', { warning });
    });
  }
}
