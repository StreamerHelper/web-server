import {
  Config,
  ILogger,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import { LoggerLevel, MidwayLogger } from '@midwayjs/logger';
import { createHash } from 'crypto';
import { format, inspect } from 'util';
import { NoticeLoggerTransport } from './notice-logger.transport';
import {
  NormalizedNotice,
  Notice,
  NoticeChannel,
  NoticeConfig,
  NoticeLevel,
  NoticeLoggerEvent,
  NoticeSendResult,
} from './notice.types';
import { ServerChanNoticeChannel } from './server-chan.notice-channel';

const NOTICE_TRANSPORT_NAME = 'notice';
const SENSITIVE_KEY =
  /password|passwd|secret|token|cookie|authorization|api[-_]?key|access[-_]?key|send[-_]?key|signature/i;

@Provide()
@Scope(ScopeEnum.Singleton)
export class NoticeService {
  @Config('streamerhelper.notice')
  private config: NoticeConfig;

  @Logger()
  private appLogger: ILogger;

  @Logger('ffmpegExitLogger')
  private ffmpegExitLogger: ILogger;

  @Logger('noticeInternalLogger')
  private internalLogger: ILogger;

  private readonly channels = new Map<string, NoticeChannel>();
  private readonly recentNotices = new Map<string, number>();
  private started = false;

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    if (!this.config?.enabled) {
      return;
    }

    this.registerConfiguredChannels();
    this.attachLoggerTransports();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    for (const [, target] of this.getLoggerTargets()) {
      this.asMidwayLogger(target)?.remove(NOTICE_TRANSPORT_NAME);
    }

    await Promise.allSettled(
      [...this.channels.values()].map(channel => channel.close?.())
    );
    this.channels.clear();
    this.recentNotices.clear();
    this.started = false;
  }

  registerChannel(channel: NoticeChannel): void {
    this.channels.set(channel.name, channel);
  }

  unregisterChannel(name: string): void {
    this.channels.delete(name);
  }

  async send(input: Notice): Promise<NoticeSendResult> {
    if (!this.config?.enabled || this.channels.size === 0) {
      return { delivered: [], failed: [], suppressed: false };
    }

    const notice = this.normalizeNotice(input);
    if (this.shouldSuppress(notice)) {
      return { delivered: [], failed: [], suppressed: true };
    }

    const delivered: string[] = [];
    const failed: NoticeSendResult['failed'] = [];

    await Promise.all(
      [...this.channels.values()].map(async channel => {
        try {
          await channel.send(notice);
          delivered.push(channel.name);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failed.push({ channel: channel.name, error: message });
          this.internalLogger?.warn('Failed to send notice', {
            channel: channel.name,
            error: message,
          });
        }
      })
    );

    return { delivered, failed, suppressed: false };
  }

  captureLoggerEvent(event: NoticeLoggerEvent): void {
    if (!this.config?.enabled || !this.config.logger.enabled) {
      return;
    }

    const content = this.formatLoggerEvent(event);

    void this.send({
      title: `[${event.level.toUpperCase()}] ${this.config.appName}`,
      content,
      level: toNoticeLevel(event.level),
      source: event.loggerName || 'logger',
      dedupeKey: `logger:${event.level}:${content}`,
      fatigueSeconds: this.config.logger.fatigueSeconds,
    });
  }

  private registerConfiguredChannels(): void {
    const serverChan = this.config.channels?.serverChan;
    if (!serverChan?.enabled) {
      return;
    }

    if (!serverChan.sendKey) {
      this.internalLogger?.warn(
        'ServerChan notice channel is enabled without a SendKey'
      );
      return;
    }

    this.registerChannel(
      new ServerChanNoticeChannel({
        sendKey: serverChan.sendKey,
        endpoint: serverChan.endpoint,
        timeoutMs: serverChan.timeoutMs,
      })
    );
  }

  private attachLoggerTransports(): void {
    if (!this.config.logger?.enabled) {
      return;
    }

    for (const [loggerName, target] of this.getLoggerTargets()) {
      const logger = this.asMidwayLogger(target);
      if (!logger) {
        this.internalLogger?.warn(
          `Notice logger transport could not be attached to ${loggerName}`
        );
        continue;
      }

      logger.remove(NOTICE_TRANSPORT_NAME);
      logger.add(
        NOTICE_TRANSPORT_NAME,
        new NoticeLoggerTransport({ level: this.config.logger.level }, event =>
          this.captureLoggerEvent({ ...event, loggerName })
        )
      );
    }
  }

  private getLoggerTargets(): Array<[string, ILogger]> {
    return [
      ['appLogger', this.appLogger],
      ['ffmpegExitLogger', this.ffmpegExitLogger],
    ];
  }

  private asMidwayLogger(logger: ILogger): MidwayLogger | undefined {
    if (
      typeof (logger as MidwayLogger)?.add === 'function' &&
      typeof (logger as MidwayLogger)?.remove === 'function'
    ) {
      return logger as MidwayLogger;
    }
    return undefined;
  }

  private normalizeNotice(input: Notice): NormalizedNotice {
    const maxLength = Math.max(this.config.maxContentLength || 4000, 256);
    return {
      ...input,
      title: input.title.replace(/[\r\n]+/g, ' ').slice(0, 128),
      content: input.content.slice(0, maxLength),
      level: input.level || 'info',
      timestamp: input.timestamp || new Date(),
    };
  }

  private shouldSuppress(notice: NormalizedNotice): boolean {
    if (!notice.dedupeKey || !notice.fatigueSeconds) {
      return false;
    }

    const now = Date.now();
    const fatigueMs = Math.max(notice.fatigueSeconds, 0) * 1000;
    const key = createHash('sha256').update(notice.dedupeKey).digest('hex');
    const lastSentAt = this.recentNotices.get(key);

    this.pruneRecentNotices(now);
    if (lastSentAt !== undefined && now - lastSentAt < fatigueMs) {
      return true;
    }

    this.recentNotices.set(key, now);
    return false;
  }

  private pruneRecentNotices(now: number): void {
    if (this.recentNotices.size < 1000) {
      return;
    }

    const retentionMs =
      Math.max(this.config.logger.fatigueSeconds || 300, 60) * 2000;
    for (const [key, timestamp] of this.recentNotices) {
      if (now - timestamp >= retentionMs) {
        this.recentNotices.delete(key);
      }
    }
  }

  private formatLoggerEvent(event: NoticeLoggerEvent): string {
    const args = event.args.map(arg => sanitizeValue(arg));
    const message = format(...args);
    const context = sanitizeLoggerContext(event.meta?.ctx);
    const sections = [
      `**日志级别**：${event.level.toUpperCase()}`,
      `**日志来源**：${event.loggerName || 'logger'}`,
      `**进程**：${process.pid}`,
      '',
      '```text',
      message,
      '```',
    ];

    if (context) {
      sections.push('', '**请求上下文**：', '```text', context, '```');
    }

    return sections.join('\n');
  }
}

function toNoticeLevel(level: LoggerLevel): NoticeLevel {
  if (level === 'error') {
    return 'error';
  }
  if (level === 'warn') {
    return 'warn';
  }
  return 'info';
}

function sanitizeLoggerContext(context: unknown): string {
  if (!context || typeof context !== 'object') {
    return '';
  }

  const ctx = context as Record<string, any>;
  const request =
    ctx.request && typeof ctx.request === 'object' ? ctx.request : {};
  const safeContext = {
    traceId: ctx.traceId,
    requestId: ctx.requestId,
    method: ctx.method || request.method,
    path: ctx.path || ctx.url || request.url,
    status: ctx.status,
  };
  const populatedContext: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(safeContext)) {
    if (value !== undefined) {
      populatedContext[key] = value;
    }
  }
  if (Object.keys(populatedContext).length === 0) {
    return '';
  }

  return inspect(populatedContext, {
    depth: 3,
    maxArrayLength: 20,
    breakLength: 100,
  });
}

function sanitizeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (depth > 6) {
    return '[Truncated]';
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeValue(item, depth + 1, seen));
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? '[REDACTED]'
      : sanitizeValue(child, depth + 1, seen);
  }
  return sanitized;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(password|passwd|secret|token|cookie|authorization|api[-_]?key|send[-_]?key)\b(\s*[:=]\s*)([^,\s;}]+)/gi,
      '$1$2[REDACTED]'
    );
}
