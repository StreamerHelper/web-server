import { Framework, IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import { SubmissionStatus } from '../entity/bilibili-submission.entity';
import { StorageDeleteJobData } from '../interface';
import { BilibiliSubmissionRepository } from '../repository/bilibili-submission.repository';
import { JobService } from '../service/job.service';

const BUSY_SUBMISSION_STATUSES = new Set<SubmissionStatus>([
  SubmissionStatus.PENDING,
  SubmissionStatus.UPLOADING,
  SubmissionStatus.SUBMITTING,
]);

const BUSY_SUBMISSION_RETRY_DELAY = 15 * 60 * 1000;

@Processor('storage-delete')
export class StorageDeleteProcessor implements IProcessor {
  @Inject()
  private jobService: JobService;

  @Inject()
  private submissionRepository: BilibiliSubmissionRepository;

  @Inject()
  private bullFramework: Framework;

  @Logger()
  private logger: ILogger;

  async execute(data: StorageDeleteJobData) {
    const { id, reason = 'scheduled' } = data;
    const job = await this.jobService.findById(id);

    if (!job) {
      this.logger.warn('Storage delete skipped because job was not found', {
        id,
        reason,
      });
      return { status: 'skipped', id };
    }

    if (reason === 'scheduled') {
      const submissions = await this.submissionRepository.findByJobId(job.jobId);
      const hasBusySubmission = submissions.some(submission =>
        BUSY_SUBMISSION_STATUSES.has(submission.status)
      );

      if (hasBusySubmission) {
        const queue = this.bullFramework.getQueue('storage-delete');
        await queue?.addJobToQueue(data, {
          delay: BUSY_SUBMISSION_RETRY_DELAY,
        });
        this.logger.info('Storage delete deferred for busy submission', {
          id,
          jobId: job.jobId,
          delayMs: BUSY_SUBMISSION_RETRY_DELAY,
        });
        return { status: 'deferred', id };
      }
    }

    const result = await this.jobService.deleteJobStorage(id, reason);

    return {
      status: 'completed',
      id,
      deletedKeys: result.deletedKeys.length,
    };
  }
}
