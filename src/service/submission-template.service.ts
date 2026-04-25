import {
  Config,
  ILogger,
  Logger,
  Provide,
  Scope,
  ScopeEnum,
} from '@midwayjs/core';
import dayjs = require('dayjs');

export interface SubmissionTemplateContext {
  streamerName?: string | null;
  roomName?: string | null;
  startedAt?: Date | number | string | null;
}

const MAX_BILIBILI_TITLE_LENGTH = 80;
const DEFAULT_FALLBACK_TITLE = '直播回放';

@Provide()
@Scope(ScopeEnum.Singleton)
export class SubmissionTemplateService {
  @Config('submission')
  private submissionConfig: {
    defaultTid: number;
    defaultTitleTemplate: string;
  };

  @Logger()
  private logger: ILogger;

  resolveTitle(
    template: string | undefined,
    context: SubmissionTemplateContext
  ): string {
    const normalizedTemplate =
      this.normalizeTemplate(template) ||
      this.normalizeTemplate(this.submissionConfig.defaultTitleTemplate) ||
      '{主播名}的直播录像 {日期}';

    return this.renderTemplate(normalizedTemplate, context);
  }

  renderTemplate(template: string, context: SubmissionTemplateContext): string {
    const startedAt = context.startedAt ? dayjs(context.startedAt) : dayjs();
    const replacements = this.buildReplacementMap(
      context.streamerName || '',
      context.roomName || '',
      startedAt.isValid() ? startedAt : dayjs()
    );

    let renderedTitle = template;
    for (const [token, value] of replacements) {
      renderedTitle = renderedTitle.split(token).join(value);
    }

    const normalizedTitle =
      renderedTitle.replace(/\s+/g, ' ').trim() || DEFAULT_FALLBACK_TITLE;
    if (normalizedTitle.length <= MAX_BILIBILI_TITLE_LENGTH) {
      return normalizedTitle;
    }

    const truncated = normalizedTitle.slice(0, MAX_BILIBILI_TITLE_LENGTH);
    this.logger.warn('Submission title exceeds bilibili limit, truncating', {
      originalLength: normalizedTitle.length,
      truncatedLength: truncated.length,
      titlePreview: truncated,
    });
    return truncated;
  }

  resolveTid(tid?: number | null): number {
    if (typeof tid === 'number' && Number.isInteger(tid) && tid > 0) {
      return tid;
    }
    return this.submissionConfig.defaultTid;
  }

  private normalizeTemplate(template?: string): string {
    return template?.trim() || '';
  }

  private buildReplacementMap(
    streamerName: string,
    roomName: string,
    startedAt: dayjs.Dayjs
  ): Array<[string, string]> {
    const date = startedAt.format('YYYY-MM-DD');
    const time = startedAt.format('HH:mm');

    return [
      ['{主播名}', streamerName],
      ['{房间名}', roomName],
      ['{日期}', date],
      ['{时间}', time],
    ];
  }
}
