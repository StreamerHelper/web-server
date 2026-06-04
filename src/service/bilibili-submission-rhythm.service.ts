import {
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { Framework } from '@midwayjs/bullmq';
import {
  PartStatus,
  SubmissionPart,
  SubmissionStatus,
} from '../entity/bilibili-submission.entity';
import { Job } from '../entity/job.entity';
import { BilibiliSubmissionRepository } from '../repository/bilibili-submission.repository';
import { SubmissionRhythmSettings } from '../interface';
import { BilibiliSubmissionService } from './bilibili-submission.service';
import { JobService } from './job.service';
import { StreamerService } from './streamer.service';

const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 12 * 60;
const SEGMENT_DURATION_SECONDS = 10;

@Provide()
@Scope(ScopeEnum.Singleton)
export class BilibiliSubmissionRhythmService {
  @Logger()
  private logger: ILogger;

  @Inject()
  private jobService: JobService;

  @Inject()
  private streamerService: StreamerService;

  @Inject()
  private submissionService: BilibiliSubmissionService;

  @Inject()
  private submissionRepository: BilibiliSubmissionRepository;

  @Inject()
  private bullFramework: Framework;

  private readonly locks = new Map<string, Promise<unknown>>();

  async handleUploadedVideoSegment(jobEntityId: string): Promise<void> {
    await this.withJobLock(jobEntityId, async () => {
      const job = await this.jobService.findById(jobEntityId);
      if (!job) {
        return;
      }

      await this.queueAvailableParts(job, false);
    });
  }

  async handleTranscriptSegmentReady(jobEntityId: string): Promise<void> {
    await this.withJobLock(jobEntityId, async () => {
      const job = await this.jobService.findById(jobEntityId);
      if (!job) {
        return;
      }

      await this.queueAvailableParts(job, false);
    });
  }

  async flushJob(jobEntityId: string): Promise<void> {
    await this.withJobLock(jobEntityId, async () => {
      const job = await this.jobService.findById(jobEntityId);
      if (!job) {
        return;
      }

      await this.queueAvailableParts(job, true);
    });
  }

  async queueNextForSubmission(submissionId: string): Promise<void> {
    const submission = await this.submissionRepository.findById(submissionId);
    if (!submission || !this.isRhythmSubmission(submission.parts || [])) {
      return;
    }

    const job = await this.jobService.findByJobId(submission.jobId);
    if (!job) {
      return;
    }

    await this.withJobLock(job.id, async () => {
      const latestJob = await this.jobService.findById(job.id);
      if (!latestJob) {
        return;
      }

      await this.queueAvailableParts(latestJob, false);
    });
  }

  private async queueAvailableParts(
    job: Job,
    flushRemainder: boolean
  ): Promise<void> {
    const streamer = await this.streamerService.findByStreamerId(
      job.streamerId
    );
    const uploadSettings = streamer?.uploadSettings || {};
    if (uploadSettings.autoUpload === false) {
      return;
    }

    const rhythm = this.normalizeRhythm(uploadSettings.rhythm);
    if (!rhythm) {
      return;
    }

    const uploadedKeys = this.getUploadedVideoKeys(
      job,
      Boolean(uploadSettings.burnInSubtitles)
    );
    if (uploadedKeys.length === 0) {
      return;
    }

    const existingSubmission = await this.findRhythmSubmission(job.jobId);
    if (
      existingSubmission &&
      this.isSubmissionBusy(existingSubmission.status)
    ) {
      return;
    }

    const plannedKeys = new Set(
      (existingSubmission?.parts || []).flatMap(part => part.s3Keys || [])
    );
    const unplannedKeys = uploadedKeys.filter(key => !plannedKeys.has(key));
    const chunks = this.buildReadyChunks(
      unplannedKeys,
      rhythm.intervalMinutes,
      flushRemainder
    );
    if (chunks.length === 0) {
      return;
    }

    if (existingSubmission) {
      const existingParts = this.submissionService.normalizeSubmissionParts(
        existingSubmission.parts || []
      );
      const newParts = chunks.map((keys, index) =>
        this.submissionService.buildSubmissionPart(
          keys,
          existingParts.length + index + 1,
          PartStatus.PENDING,
          rhythm.intervalMinutes,
          {
            burnInSubtitles: uploadSettings.burnInSubtitles,
          }
        )
      );

      existingSubmission.parts = [...existingParts, ...newParts];
      existingSubmission.totalParts = existingSubmission.parts.length;
      existingSubmission.completedParts = existingSubmission.parts.filter(
        part => part.status === PartStatus.COMPLETED
      ).length;
      existingSubmission.status = SubmissionStatus.PENDING;
      existingSubmission.lastError = null;
      await this.submissionRepository.save(existingSubmission);

      await this.enqueueSubmission(existingSubmission.id);

      this.logger.info('Queued segmented append submission', {
        jobId: job.jobId,
        submissionId: existingSubmission.id,
        newPartCount: newParts.length,
      });
      return;
    }

    const parts = chunks.map((keys, index) =>
      this.submissionService.buildSubmissionPart(
        keys,
        index + 1,
        PartStatus.PENDING,
        rhythm.intervalMinutes,
        {
          burnInSubtitles: uploadSettings.burnInSubtitles,
        }
      )
    );
    const submission = await this.submissionService.createSubmission({
      jobId: job.jobId,
      parts,
      title: uploadSettings.title,
      description: uploadSettings.description,
      tags: uploadSettings.tags || [],
      humanType2: uploadSettings.humanType2,
      collection: uploadSettings.collection,
      burnInSubtitles: uploadSettings.burnInSubtitles,
    });

    await this.enqueueSubmission(submission.id);

    this.logger.info('Queued first segmented submission', {
      jobId: job.jobId,
      submissionId: submission.id,
      partCount: parts.length,
    });
  }

  private normalizeRhythm(
    settings?: SubmissionRhythmSettings
  ): { intervalMinutes: number } | null {
    if (settings?.mode !== 'segmented') {
      return null;
    }

    const rawInterval = Number(settings.intervalMinutes);
    const intervalMinutes = Number.isFinite(rawInterval)
      ? Math.floor(rawInterval)
      : DEFAULT_INTERVAL_MINUTES;

    return {
      intervalMinutes: Math.min(
        Math.max(intervalMinutes, MIN_INTERVAL_MINUTES),
        MAX_INTERVAL_MINUTES
      ),
    };
  }

  private getUploadedVideoKeys(job: Job, requireTranscript: boolean): string[] {
    const videoKeys = (job.metadata?.uploadedSegments || [])
      .filter(key => key.includes('/video/'))
      .sort();
    if (!requireTranscript) {
      return videoKeys;
    }

    const transcriptSegmentIds = new Set(
      (job.metadata?.transcriptIndex?.segments || []).map(segment =>
        String(segment.segmentId)
      )
    );
    const readyKeys = videoKeys.filter(key =>
      transcriptSegmentIds.has(this.getSegmentId(key))
    );

    if (readyKeys.length < videoKeys.length) {
      this.logger.info('Waiting for transcript segments before submission', {
        jobId: job.jobId,
        uploadedVideoSegments: videoKeys.length,
        transcriptReadyVideoSegments: readyKeys.length,
      });
    }

    return readyKeys;
  }

  private getSegmentId(s3Key: string): string {
    return s3Key
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '');
  }

  private buildReadyChunks(
    keys: string[],
    intervalMinutes: number,
    flushRemainder: boolean
  ): string[][] {
    const segmentsPerPart = Math.max(
      1,
      Math.floor((intervalMinutes * 60) / SEGMENT_DURATION_SECONDS)
    );
    const chunks: string[][] = [];
    const sortedKeys = [...keys].sort();

    while (sortedKeys.length >= segmentsPerPart) {
      chunks.push(sortedKeys.splice(0, segmentsPerPart));
    }

    if (flushRemainder && sortedKeys.length > 0) {
      chunks.push(sortedKeys);
    }

    return chunks;
  }

  private async findRhythmSubmission(jobId: string) {
    const submissions = await this.submissionRepository.findByJobId(jobId);
    return (
      submissions.find(submission =>
        this.isRhythmSubmission(submission.parts || [])
      ) || null
    );
  }

  private isRhythmSubmission(parts: SubmissionPart[]): boolean {
    return parts.some(part => Boolean(part.rhythmIntervalMinutes));
  }

  private isSubmissionBusy(status: SubmissionStatus): boolean {
    return [
      SubmissionStatus.PENDING,
      SubmissionStatus.UPLOADING,
      SubmissionStatus.SUBMITTING,
    ].includes(status);
  }

  private async enqueueSubmission(submissionId: string): Promise<void> {
    const queue = this.bullFramework.getQueue('bilibili-submission');
    if (!queue) {
      this.logger.warn('Bilibili submission queue is unavailable', {
        submissionId,
      });
      return;
    }

    await queue.addJobToQueue({ submissionId });
  }

  private async withJobLock<T>(
    jobKey: string,
    task: () => Promise<T>
  ): Promise<T> {
    const previous = this.locks.get(jobKey) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const cleanup = current.finally(() => {
      if (this.locks.get(jobKey) === cleanup) {
        this.locks.delete(jobKey);
      }
    });
    this.locks.set(jobKey, cleanup);

    return current;
  }
}
