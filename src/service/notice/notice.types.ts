import { LoggerLevel, LogMeta } from '@midwayjs/logger';

export type NoticeLevel = 'info' | 'warn' | 'error';

export interface Notice {
  title: string;
  content: string;
  level?: NoticeLevel;
  source?: string;
  timestamp?: Date;
  dedupeKey?: string;
  cooldownSeconds?: number;
}

export interface NormalizedNotice extends Omit<Notice, 'level' | 'timestamp'> {
  level: NoticeLevel;
  timestamp: Date;
}

export interface NoticeChannel {
  readonly name: string;
  send(notice: NormalizedNotice): Promise<void>;
  close?(): Promise<void> | void;
}

export interface NoticeSendFailure {
  channel: string;
  error: string;
}

export interface NoticeSendResult {
  delivered: string[];
  failed: NoticeSendFailure[];
  suppressed: boolean;
}

export interface NoticeLoggerEvent {
  level: LoggerLevel;
  meta: LogMeta;
  args: unknown[];
  loggerName?: string;
}

export interface NoticeConfig {
  enabled: boolean;
  appName: string;
  maxContentLength: number;
  logger: {
    enabled: boolean;
    level: LoggerLevel;
    cooldownSeconds: number;
  };
  channels: {
    serverChan: {
      enabled: boolean;
      sendKey: string;
      endpoint: string;
      timeoutMs: number;
    };
  };
}
