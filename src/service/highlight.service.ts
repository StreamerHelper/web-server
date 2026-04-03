import {
  App,
  ILogger,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { Application } from '@midwayjs/koa';
import { EventEmitter } from 'events';
import { DanmakuMessage, Highlight, SegmentInfo } from '../interface';

export interface HighlightDetectorConfig {
  /** 滑动窗口大小（毫秒），默认 10 秒 */
  windowSize: number;
  /** 滑动步长（毫秒），默认 1 秒 */
  slideStep: number;
  /** 触发阈值：当前密度超过均值的倍数，默认 2.5 */
  triggerThreshold: number;
  /** 结束阈值：密度回落到此倍数以下认为高潮结束，默认 1.5 */
  endThreshold: number;
  /** 最小高光时长（毫秒），默认 10 秒 */
  minHighlightDuration: number;
  /** 最大高光时长（毫秒），默认 5 分钟 */
  maxHighlightDuration: number;
  /** 高光前后缓冲时间（毫秒），默认 5 秒 */
  bufferTime: number;
  /** 两个高光之间的最小间隔（毫秒），默认 30 秒 */
  cooldownPeriod: number;
}

const DEFAULT_CONFIG: HighlightDetectorConfig = {
  windowSize: 10000,
  slideStep: 1000,
  triggerThreshold: 2.5,
  endThreshold: 1.5,
  minHighlightDuration: 10000,
  maxHighlightDuration: 300000,
  bufferTime: 5000,
  cooldownPeriod: 30000,
};

interface DanmakuWithTime {
  message: DanmakuMessage;
  relativeTime: number;
}

interface ActiveHighlight {
  id: string;
  startTime: number;
  peakDensity: number;
  triggerTime: number;
  messages: DanmakuWithTime[];
}

@Provide()
@Scope(ScopeEnum.Request)
export class HighlightService extends EventEmitter {
  @App()
  app: Application;

  @Logger()
  private logger: ILogger;
  private config: HighlightDetectorConfig;
  private jobId: string;

  // 弹幕缓冲区
  private danmakuBuffer: DanmakuWithTime[] = [];
  private maxBufferDuration = 60000;

  // 历史密度统计
  private densityHistory: number[] = [];
  private densitySum = 0;
  private maxHistorySize = 60;

  // 当前活跃的高光
  private activeHighlight: ActiveHighlight | null = null;
  private lastHighlightEndTime = 0;
  private highlightCounter = 0;

  // 已记录的 segment
  private segments = new Map<number, SegmentInfo>();
  private segmentDuration = 10000;

  // 检测定时器
  private detectTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * 启动检测器
   */
  start(
    jobId: string,
    segmentDuration = 10,
    config?: Partial<HighlightDetectorConfig>
  ): void {
    if (this.isRunning) return;

    this.jobId = jobId;
    this.segmentDuration = segmentDuration * 1000;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isRunning = true;

    // 启动定时检测
    this.detectTimer = setInterval(
      () => this.detectHighlight(),
      this.config.slideStep
    );

    this.logger.info('Highlight detector started', { jobId });
  }

  /**
   * 停止检测器
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.detectTimer) {
      clearInterval(this.detectTimer);
      this.detectTimer = null;
    }

    // 如果有活跃的高光，强制结束
    if (this.activeHighlight) {
      this.endHighlight(Date.now() - this.activeHighlight.startTime);
    }

    this.logger.info('Highlight detector stopped', {
      jobId: this.jobId,
      totalHighlights: this.highlightCounter,
    });
  }

  /**
   * 处理弹幕消息
   */
  handleDanmaku(message: DanmakuMessage, relativeTime: number): void {
    const danmakuWithTime: DanmakuWithTime = { message, relativeTime };
    this.danmakuBuffer.push(danmakuWithTime);

    if (this.activeHighlight) {
      this.activeHighlight.messages.push(danmakuWithTime);
    }

    this.cleanupBuffer(relativeTime);
  }

  /**
   * 处理 segment 事件
   */
  handleSegment(segment: SegmentInfo, segmentIndex: number): void {
    if (segment.type !== 'video') return;

    const segmentStartTime = segmentIndex * this.segmentDuration;
    this.segments.set(segmentStartTime, segment);
  }

  /**
   * 核心检测逻辑
   */
  private detectHighlight(): void {
    const now = this.getCurrentTime();
    const windowStart = now - this.config.windowSize;

    const currentDensity = this.calculateDensity(windowStart, now);
    this.updateDensityHistory(currentDensity);

    const avgDensity = this.getAverageDensity();
    const inCooldown =
      now - this.lastHighlightEndTime < this.config.cooldownPeriod;

    if (this.activeHighlight) {
      const duration = now - this.activeHighlight.startTime;

      if (currentDensity > this.activeHighlight.peakDensity) {
        this.activeHighlight.peakDensity = currentDensity;
      }

      this.emit('highlight:ongoing', {
        jobId: this.jobId,
        highlightId: this.activeHighlight.id,
        currentDensity,
        duration,
      });

      const shouldEnd =
        currentDensity < avgDensity * this.config.endThreshold ||
        duration >= this.config.maxHighlightDuration;

      if (shouldEnd && duration >= this.config.minHighlightDuration) {
        this.endHighlight(now);
      } else if (duration >= this.config.maxHighlightDuration) {
        this.endHighlight(now);
      }
    } else if (!inCooldown && avgDensity > 0) {
      if (currentDensity >= avgDensity * this.config.triggerThreshold) {
        this.startHighlight(now, currentDensity);
      }
    }
  }

  /**
   * 开始追踪高光
   */
  private startHighlight(currentTime: number, density: number): void {
    this.highlightCounter++;
    const highlightId = `${this.jobId}-highlight-${this.highlightCounter}`;

    this.activeHighlight = {
      id: highlightId,
      startTime: currentTime - this.config.bufferTime,
      peakDensity: density,
      triggerTime: currentTime,
      messages: [],
    };

    const bufferStart = this.activeHighlight.startTime;
    for (const d of this.danmakuBuffer) {
      if (d.relativeTime >= bufferStart) {
        this.activeHighlight.messages.push(d);
      }
    }

    this.emit('highlight:started', {
      jobId: this.jobId,
      highlightId,
      startTime: this.activeHighlight.startTime,
      triggerDensity: density,
    });

    this.logger.info('Highlight started', {
      jobId: this.jobId,
      highlightId,
      startTime: this.activeHighlight.startTime,
      triggerDensity: density,
    });
  }

  /**
   * 结束高光追踪
   */
  private endHighlight(currentTime: number): void {
    if (!this.activeHighlight) return;

    const endTime = currentTime + this.config.bufferTime;
    const startTime = this.activeHighlight.startTime;
    const duration = endTime - startTime;

    const score = this.calculateHighlightScore(
      this.activeHighlight.peakDensity,
      duration,
      this.activeHighlight.messages.length
    );

    const highlight: Highlight = {
      start: startTime,
      end: endTime,
      score,
      reason: `Peak density: ${this.activeHighlight.peakDensity.toFixed(
        2
      )}, Duration: ${(duration / 1000).toFixed(1)}s`,
    };

    const involvedSegments = this.findInvolvedSegments(startTime, endTime);

    this.emit('highlight:ended', {
      jobId: this.jobId,
      highlightId: this.activeHighlight.id,
      highlight,
      segments: involvedSegments,
    });

    this.logger.info('Highlight ended', {
      jobId: this.jobId,
      highlightId: this.activeHighlight.id,
      startTime,
      endTime,
      duration,
      score,
      segmentCount: involvedSegments.length,
    });

    this.lastHighlightEndTime = currentTime;
    this.activeHighlight = null;
  }

  /**
   * 计算指定时间窗口内的弹幕密度
   */
  private calculateDensity(windowStart: number, windowEnd: number): number {
    let count = 0;
    let giftValue = 0;

    for (const d of this.danmakuBuffer) {
      if (d.relativeTime >= windowStart && d.relativeTime <= windowEnd) {
        count++;
        if (d.message.type === 'gift' && d.message.gift) {
          giftValue += d.message.gift.value;
        }
      }
    }

    const windowSeconds = (windowEnd - windowStart) / 1000;
    return count / windowSeconds + giftValue * 0.5;
  }

  /**
   * 更新历史密度
   */
  private updateDensityHistory(density: number): void {
    this.densityHistory.push(density);
    this.densitySum += density;

    if (this.densityHistory.length > this.maxHistorySize) {
      const removed = this.densityHistory.shift()!;
      this.densitySum -= removed;
    }
  }

  /**
   * 获取平均密度
   */
  private getAverageDensity(): number {
    if (this.densityHistory.length === 0) return 0;
    return this.densitySum / this.densityHistory.length;
  }

  /**
   * 计算高光得分
   */
  private calculateHighlightScore(
    peakDensity: number,
    duration: number,
    messageCount: number
  ): number {
    const densityScore = Math.min(peakDensity * 10, 100);
    const durationScore = Math.min(duration / 1000, 60);
    const countScore = Math.min(messageCount / 10, 40);

    return densityScore * 0.5 + durationScore * 0.3 + countScore * 0.2;
  }

  /**
   * 找出涉及的 segment 文件
   */
  private findInvolvedSegments(startTime: number, endTime: number): string[] {
    const involvedPaths: string[] = [];

    for (const [segmentStartTime, segment] of this.segments) {
      const segmentEndTime = segmentStartTime + this.segmentDuration;

      if (segmentStartTime <= endTime && segmentEndTime >= startTime) {
        involvedPaths.push(segment.localPath);
      }
    }

    return involvedPaths.sort();
  }

  /**
   * 清理过期的弹幕缓冲
   */
  private cleanupBuffer(currentTime: number): void {
    const cutoffTime = currentTime - this.maxBufferDuration;

    while (
      this.danmakuBuffer.length > 0 &&
      this.danmakuBuffer[0].relativeTime < cutoffTime
    ) {
      this.danmakuBuffer.shift();
    }
  }

  /**
   * 获取当前相对时间
   */
  private getCurrentTime(): number {
    if (this.danmakuBuffer.length === 0) return 0;
    return this.danmakuBuffer[this.danmakuBuffer.length - 1].relativeTime;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    bufferSize: number;
    historySize: number;
    avgDensity: number;
    activeHighlight: boolean;
    totalHighlights: number;
  } {
    return {
      bufferSize: this.danmakuBuffer.length,
      historySize: this.densityHistory.length,
      avgDensity: this.getAverageDensity(),
      activeHighlight: this.activeHighlight !== null,
      totalHighlights: this.highlightCounter,
    };
  }
}
