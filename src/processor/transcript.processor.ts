import { Framework, IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TranscriptJobData, TranscriptUploadJobData } from '../interface/data';
import { AsrService, AsrServiceOptions } from '../service/asr.service';
import { StorageService } from '../service/storage.service';
import { JobService } from '../service/job.service';

@Processor('transcript')
export class TranscriptProcessor implements IProcessor {
  @Inject()
  asrService: AsrService;

  @Inject()
  storageService: StorageService;

  @Inject()
  jobService: JobService;

  @Inject()
  bullFramework: Framework;

  @Logger()
  private logger: ILogger;

  async execute(data: TranscriptJobData) {
    const {
      id,
      segmentId,
      videoS3Key,
      localVideoPath: preferredLocalVideoPath,
      outputS3Key,
      startTimeOffsetMs = 0,
    } = data;

    this.logger.info('Processing transcript job', {
      id,
      segmentId,
      videoS3Key,
      preferredLocalVideoPath,
    });

    let tempDir: string | null = null;

    try {
      // TODO: 检查 ASR 服务是否可用
      if (!this.asrService.isAvailable()) {
        this.logger.warn('ASR service is not available, skipping transcript', {
          id,
          segmentId,
        });
        return {
          status: 'skipped',
          id,
          segmentId,
          reason: 'ASR service unavailable',
        };
      }

      // 创建临时目录
      tempDir = path.join(
        process.cwd(),
        'temp',
        `${id}-transcript-${segmentId}-${Date.now()}`
      );
      await fs.mkdir(tempDir, { recursive: true });

      const localVideoPath =
        preferredLocalVideoPath && (await this.fileExists(preferredLocalVideoPath))
          ? preferredLocalVideoPath
          : await this.downloadVideoSegment(videoS3Key, tempDir);

      // 调用 ASR 服务进行转录
      const asrOptions: AsrServiceOptions = {
        id,
        outputDir: tempDir,
        language: 'zh-CN',
        enablePunctuation: true,
        enableInterimResults: false,
      };

      const result = await this.asrService.transcribeFile(
        localVideoPath,
        asrOptions
      );
      if (startTimeOffsetMs > 0) {
        result.messages = result.messages.map(message => ({
          ...message,
          timestamp: message.timestamp + startTimeOffsetMs,
          words: message.words?.map(word => ({
            ...word,
            startTime: word.startTime + startTimeOffsetMs,
            endTime: word.endTime + startTimeOffsetMs,
          })),
        }));
      }

      this.logger.info('Transcription completed', {
        id,
        segmentId,
        messageCount: result.messages.length,
        duration: result.duration,
        startTimeOffsetMs,
      });

      // 保存转录结果到本地
      const localTranscriptPath = path.join(tempDir, `${segmentId}.jsonl`);
      await this.asrService.saveToFile(result, localTranscriptPath);

      // 调度上传任务
      const transcriptUploadQueue =
        this.bullFramework.getQueue('transcript-upload');
      if (transcriptUploadQueue) {
        await transcriptUploadQueue.addJobToQueue({
          id,
          segmentId,
          s3Key: outputS3Key,
          localPath: localTranscriptPath,
        } as TranscriptUploadJobData);
      } else {
        this.logger.warn('Transcript upload queue not found', {
          id,
          segmentId,
          localTranscriptPath,
        });
        await this.cleanup(tempDir);
      }

      return {
        status: 'completed',
        id,
        segmentId,
        messageCount: result.messages.length,
        duration: result.duration,
      };
    } catch (error) {
      this.logger.error('Transcript job failed', {
        id,
        segmentId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (tempDir) {
        await this.cleanup(tempDir);
      }

      throw error;
    }
  }

  /**
   * 清理临时文件
   */
  private async cleanup(tempDir: string): Promise<void> {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn('Failed to cleanup temp dir', {
        tempDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      this.logger.info('Using local video segment for transcript', {
        localVideoPath: filePath,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async downloadVideoSegment(
    videoS3Key: string,
    tempDir: string
  ): Promise<string> {
    const videoFileName = path.basename(videoS3Key);
    const localVideoPath = path.join(tempDir, videoFileName);
    const videoData = await this.storageService.download(videoS3Key);
    await fs.writeFile(localVideoPath, videoData);

    this.logger.info('Video segment downloaded for transcript', {
      videoS3Key,
      localVideoPath,
    });

    return localVideoPath;
  }
}
