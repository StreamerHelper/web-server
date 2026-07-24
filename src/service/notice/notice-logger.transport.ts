import {
  isEnableLevel,
  LoggerLevel,
  LogMeta,
  Transport,
} from '@midwayjs/logger';
import { NoticeLoggerEvent } from './notice.types';

export interface NoticeLoggerTransportOptions {
  level: LoggerLevel;
}

export class NoticeLoggerTransport extends Transport<NoticeLoggerTransportOptions> {
  constructor(
    options: NoticeLoggerTransportOptions,
    private readonly handleEvent: (event: NoticeLoggerEvent) => void
  ) {
    super(options);
  }

  log(level: LoggerLevel | false, meta: LogMeta, ...args: unknown[]): void {
    if (!level || !isEnableLevel(level, this.level)) {
      return;
    }

    this.handleEvent({ level, meta, args });
  }

  close(): void {
    // NoticeService owns channel lifecycle; the transport has no resources.
  }
}
