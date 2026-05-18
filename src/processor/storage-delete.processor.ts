import { Framework, IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import { SubmissionStatus } from '../entity/bilibili-submission.entity';
import { Job } from '../entity/job.entity';
import {
  RecordingAutoDeleteSettings,
  StorageDeleteJobData,
} from '../interface';
import { BilibiliSubmissionRepository } from '../repository/bilibili-submission.repository';
import { JobService } from '../service/job.service';
import { StreamerService } from '../service/streamer.service';
import { normalizeAutoDeleteSettings } from '../utils/record-settings';

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
  private streamerService: StreamerService;

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
      const currentSettingsCheck = await this.checkCurrentAutoDeleteSettings(
        job,
        data
      );
      if (currentSettingsCheck) {
        return currentSettingsCheck;
      }

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

  private async checkCurrentAutoDeleteSettings(
    job: Job,
    data: StorageDeleteJobData
  ) {
    const streamer = await this.streamerService.findByStreamerId(
      job.streamerId
    );
    const currentAutoDelete = normalizeAutoDeleteSettings(
      streamer?.recordSettings?.autoDelete
    );

    if (!streamer || streamer.platform !== job.platform || !currentAutoDelete) {
      await this.jobService.updateMetadata(job.id, {
        storageDeleteSkippedAt: new Date().toISOString(),
        storageDeleteSkipReason: !streamer
          ? 'streamer_not_found'
          : streamer.platform !== job.platform
            ? 'streamer_platform_mismatch'
            : 'auto_delete_disabled',
      });
      this.logger.info('Storage delete skipped by current streamer settings', {
        id: job.id,
        jobId: job.jobId,
        streamerId: job.streamerId,
        platform: job.platform,
      });
      return { status: 'skipped', id: job.id };
    }

    const dueAt = this.resolveCurrentDueAt(job, currentAutoDelete);
    const delayMs = dueAt.getTime() - Date.now();
    if (delayMs <= 0) {
      return null;
    }

    const queue = this.bullFramework.getQueue('storage-delete');
    await queue?.addJobToQueue(data, { delay: delayMs });
    await this.jobService.updateMetadata(job.id, {
      autoDelete: currentAutoDelete,
      storageDeleteScheduledAt: dueAt.toISOString(),
      storageDeleteDelayMinutes: currentAutoDelete.delayMinutes,
    });
    this.logger.info('Storage delete deferred by current streamer settings', {
      id: job.id,
      jobId: job.jobId,
      delayMs,
      scheduledAt: dueAt.toISOString(),
    });

    return { status: 'deferred', id: job.id };
  }

  private resolveCurrentDueAt(
    job: Job,
    autoDelete: RecordingAutoDeleteSettings
  ): Date {
    const baseTime = this.resolveDeleteBaseTime(job);
    return new Date(baseTime + autoDelete.delayMinutes! * 60 * 1000);
  }

  private resolveDeleteBaseTime(job: Job): number {
    if (job.endTime) {
      return job.endTime.getTime();
    }

    const scheduledAt = Date.parse(job.metadata?.storageDeleteScheduledAt || '');
    const delayMinutes = job.metadata?.storageDeleteDelayMinutes;
    if (Number.isFinite(scheduledAt) && Number.isFinite(delayMinutes)) {
      return scheduledAt - Number(delayMinutes) * 60 * 1000;
    }

    return job.createdAt?.getTime() || Date.now();
  }
}
