import { IProcessor, Processor } from '@midwayjs/bullmq';
import { ILogger, Inject, Logger } from '@midwayjs/core';
import { AnalysisResult, AnalyzeJobData, Highlight } from '../interface';
import { JobService } from '../service/job.service';
import { StorageService } from '../service/storage.service';

@Processor('analyze')
export class AnalyzeProcessor implements IProcessor {
  @Inject()
  storageService: StorageService;

  @Inject()
  jobService: JobService;

  @Logger()
  private logger: ILogger;

  async execute(data: AnalyzeJobData) {
    const { id, danmakuPath } = data;

    this.logger.info('Starting analyze job', { id, danmakuPath });

    try {
      // 下载弹幕数据
      const danmakuData = await this.storageService.download(danmakuPath);
      const jsonl = danmakuData.toString('utf-8');

      // 解析弹幕
      const messages = jsonl
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));

      this.logger.info('Danmaku messages loaded', {
        id,
        count: messages.length,
      });

      // 分析弹幕数据
      const result = await this.analyzeDanmaku(id, messages);

      // 获取任务的高光信息
      const job = await this.jobService.findById(id);
      const highlights = job?.metadata?.highlights || [];

      // 更新任务元数据
      await this.jobService.updateMetadata(id, {
        statistics: result.metadata,
        highlights,
      });

      this.logger.info('Analyze job completed', {
        id,
        highlights: highlights.length,
        totalScore: result.totalScore,
      });

      return {
        status: 'completed',
        id,
        ...result,
      };
    } catch (error) {
      this.logger.error('Analyze job failed', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /**
   * 分析弹幕数据
   */
  private async analyzeDanmaku(
    id: string,
    messages: any[]
  ): Promise<AnalysisResult> {
    const timeBuckets = new Map<
      number,
      {
        chatCount: number;
        giftValue: number;
        uniqueUsers: Set<string>;
      }
    >();

    const totalChats = messages.length;
    const totalGiftValue = messages.reduce((sum, msg) => {
      if (msg.type === 'gift' && msg.gift) {
        return sum + msg.gift.value * msg.gift.count;
      }
      return sum;
    }, 0);

    const uniqueViewers = new Set<string>();
    const bucketSize = 10000; // 10秒

    // 统计数据
    for (const msg of messages) {
      uniqueViewers.add(msg.userId);

      // 计算时间桶
      const bucketKey = Math.floor(msg.timestamp / bucketSize) * bucketSize;

      if (!timeBuckets.has(bucketKey)) {
        timeBuckets.set(bucketKey, {
          chatCount: 0,
          giftValue: 0,
          uniqueUsers: new Set(),
        });
      }

      const bucket = timeBuckets.get(bucketKey)!;
      bucket.chatCount++;
      bucket.uniqueUsers.add(msg.userId);

      if (msg.type === 'gift' && msg.gift) {
        bucket.giftValue += msg.gift.value * msg.gift.count;
      }
    }

    // 计算高光时刻
    const highlights: Highlight[] = [];
    let avgDensity = 0;

    const densities = Array.from(timeBuckets.values()).map(b => {
      return b.chatCount + b.giftValue * 0.5;
    });

    if (densities.length > 0) {
      avgDensity = densities.reduce((a, b) => a + b, 0) / densities.length;
    }

    // 使用标准差检测高光
    const variance =
      densities.reduce((sum, d) => sum + Math.pow(d - avgDensity, 2), 0) /
      densities.length;
    const stdDev = Math.sqrt(variance);
    const threshold = avgDensity + stdDev;

    let currentHighlight: Highlight | null = null;

    for (const [timestamp, bucket] of timeBuckets) {
      const density = bucket.chatCount + bucket.giftValue * 0.5;

      if (density > threshold && !currentHighlight) {
        // 开始新高光
        currentHighlight = {
          start: timestamp,
          end: timestamp + bucketSize,
          score: density,
          reason: `High activity: ${bucket.chatCount} chats, ${bucket.giftValue} gift value`,
        };
      } else if (currentHighlight) {
        if (density < threshold) {
          // 结束高光
          currentHighlight.end = timestamp;
          highlights.push(currentHighlight);
          currentHighlight = null;
        } else {
          // 延长高光
          currentHighlight.end = timestamp + bucketSize;
          currentHighlight.score = Math.max(currentHighlight.score, density);
        }
      }
    }

    // 确保最后一个高光被记录
    if (currentHighlight) {
      highlights.push(currentHighlight);
    }

    // 计算总分
    const totalScore = highlights.reduce((sum, h) => sum + h.score, 0);

    return {
      duration: timeBuckets.size * bucketSize,
      totalScore,
      hasHighlights: highlights.length > 0,
      highlights,
      metadata: {
        totalChats,
        totalGiftValue,
        uniqueViewers: uniqueViewers.size,
      },
    };
  }
}
