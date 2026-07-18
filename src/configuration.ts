import * as bullBoard from '@midwayjs/bull-board';
import * as bullmq from '@midwayjs/bullmq';
import { Framework } from '@midwayjs/bullmq';
import { Configuration, ILogger, Inject, Logger } from '@midwayjs/core';
import * as koa from '@midwayjs/koa';
import * as orm from '@midwayjs/typeorm';
import * as validate from '@midwayjs/validate';
import { join } from 'path';
import { BilibiliSubmissionRecoveryService } from './service/bilibili-submission-recovery.service';

@Configuration({
  imports: [koa, validate, bullmq, bullBoard, orm],
  importConfigs: [join(__dirname, './config')],
})
export class MainConfiguration {
  @Inject()
  bullFramework: Framework;

  @Inject()
  bilibiliSubmissionRecoveryService: BilibiliSubmissionRecoveryService;

  @Logger()
  logger: ILogger;

  async onServerReady() {
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

  private setupGlobalErrorHandlers(): void {
    process.on('unhandledRejection', (reason: unknown) => {
      console.error('[Unhandled Promise Rejection]', reason);
    });

    process.on('uncaughtException', (error: Error) => {
      console.error('[Uncaught Exception]', error.message, error.stack);
      // process.exit(1);
    });

    process.on('warning', warning => {
      console.warn('[Process Warning]', warning);
    });
  }
}
