import * as bullBoard from '@midwayjs/bull-board';
import * as bullmq from '@midwayjs/bullmq';
import { Framework } from '@midwayjs/bullmq';
import { Configuration, Inject } from '@midwayjs/core';
import * as koa from '@midwayjs/koa';
import * as orm from '@midwayjs/typeorm';
import * as validate from '@midwayjs/validate';
import { join } from 'path';

@Configuration({
  imports: [koa, validate, bullmq, bullBoard, orm],
  importConfigs: [join(__dirname, './config')],
})
export class MainConfiguration {
  @Inject()
  bullFramework: Framework;

  async onServerReady() {
    this.setupGlobalErrorHandlers();

    const pollerQueue = this.bullFramework.getQueue('poller');
    await pollerQueue?.addJobToQueue(null);
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
