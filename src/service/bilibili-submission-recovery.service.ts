import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { Framework } from '@midwayjs/bullmq';
import { BilibiliSubmissionRepository } from '../repository/bilibili-submission.repository';

@Provide()
@Scope(ScopeEnum.Singleton)
export class BilibiliSubmissionRecoveryService {
  @Logger()
  private logger: ILogger;

  @Inject()
  private bullFramework: Framework;

  @Inject()
  private submissionRepository: BilibiliSubmissionRepository;

  async resumeRecoverableSubmissions(): Promise<number> {
    const queue = this.bullFramework.getQueue('bilibili-submission');
    if (!queue) {
      this.logger.warn(
        'Bilibili submission queue is unavailable during resume'
      );
      return 0;
    }

    const submissions =
      await this.submissionRepository.findRecoverableSubmissions();
    if (submissions.length === 0) {
      return 0;
    }

    const queuedJobs = await queue.getJobs([
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'paused',
      'waiting-children',
    ]);
    const queuedSubmissionIds = new Set(
      queuedJobs
        .map(job => job.data?.submissionId)
        .filter((submissionId): submissionId is string => Boolean(submissionId))
    );
    const resumedSubmissionIds: string[] = [];

    for (const submission of submissions) {
      if (queuedSubmissionIds.has(submission.id)) {
        continue;
      }

      await queue.addJobToQueue(
        { submissionId: submission.id },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
        }
      );
      resumedSubmissionIds.push(submission.id);
    }

    if (resumedSubmissionIds.length > 0) {
      this.logger.info('Resumed recoverable bilibili submissions', {
        count: resumedSubmissionIds.length,
        submissionIds: resumedSubmissionIds,
      });
    }

    return resumedSubmissionIds.length;
  }
}
