import { Framework } from '@midwayjs/bullmq';
import {
  Config,
  ILogger,
  Inject,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import * as path from 'path';
import { TranscriptJobData } from '../interface/data';
import { AsrService } from './asr.service';

interface AsrQueueConfig {
  enabled?: boolean;
  transcribeRecordings?: boolean;
}

export interface ScheduleTranscriptSegmentInput {
  id: string;
  videoS3Key: string;
  localVideoPath?: string;
  startTimeOffsetMs?: number;
}

@Provide()
@Scope(ScopeEnum.Singleton)
export class TranscriptSchedulerService {
  @Inject()
  private bullFramework: Framework;

  @Inject()
  private asrService: AsrService;

  @Config('streamerhelper.asr')
  private asrConfig: AsrQueueConfig;

  @Logger()
  private logger: ILogger;

  async scheduleForVideoSegment(
    input: ScheduleTranscriptSegmentInput
  ): Promise<boolean> {
    const { id, videoS3Key, localVideoPath, startTimeOffsetMs = 0 } = input;
    if (!videoS3Key.includes('/video/')) {
      return false;
    }
    if (!this.asrConfig?.enabled || !this.asrConfig?.transcribeRecordings) {
      return false;
    }
    if (!this.asrService.isAvailable()) {
      this.logger.debug('ASR service unavailable, skip transcript scheduling', {
        id,
        videoS3Key,
      });
      return false;
    }

    const transcriptQueue = this.bullFramework.getQueue('transcript');
    if (!transcriptQueue) {
      this.logger.warn('Transcript queue not found', { id, videoS3Key });
      return false;
    }

    const segmentId = this.getSegmentId(videoS3Key);
    const outputS3Key = `transcript/${id}/${segmentId}.jsonl`;

    await transcriptQueue.addJobToQueue(
      {
        id,
        segmentId,
        videoS3Key,
        localVideoPath,
        outputS3Key,
        startTimeOffsetMs,
      } as TranscriptJobData,
      {
        attempts: 2,
        jobId: `transcript:${id}:${segmentId}`,
      }
    );

    this.logger.info('Transcript job scheduled', {
      id,
      segmentId,
      videoS3Key,
      localVideoPath,
      outputS3Key,
      startTimeOffsetMs,
    });

    return true;
  }

  private getSegmentId(s3Key: string): string {
    return path.basename(s3Key).replace(/\.[^.]+$/, '');
  }
}
