import { NormalizedNotice, NoticeChannel } from './notice.types';

export interface ServerChanNoticeChannelOptions {
  sendKey: string;
  endpoint?: string;
  timeoutMs?: number;
}

type Fetcher = typeof fetch;

interface ServerChanResponse {
  code?: number;
  message?: string;
}

export class ServerChanNoticeChannel implements NoticeChannel {
  readonly name = 'serverChan';

  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(
    options: ServerChanNoticeChannelOptions,
    private readonly fetcher: Fetcher = fetch
  ) {
    this.endpoint = resolveServerChanEndpoint(
      options.sendKey,
      options.endpoint
    );
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(notice: NormalizedNotice): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const body = new URLSearchParams({
      title: notice.title.replace(/[\r\n]+/g, ' '),
      desp: formatServerChanContent(notice),
    });

    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
        signal: controller.signal,
      });
      const responseText = await response.text();
      let payload: ServerChanResponse = {};

      try {
        payload = JSON.parse(responseText) as ServerChanResponse;
      } catch {
        // HTTP status still provides a useful failure signal.
      }

      if (!response.ok || payload.code !== 0) {
        const reason =
          payload.message ||
          `HTTP ${response.status}${
            responseText ? ' with invalid response' : ''
          }`;
        throw new Error(`ServerChan rejected the notice: ${reason}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function resolveServerChanEndpoint(
  sendKey: string,
  endpoint = ''
): string {
  const encodedSendKey = encodeURIComponent(sendKey);
  const uidMatch = /^sctp(\d+)t/i.exec(sendKey);
  const uid = uidMatch?.[1] || '';

  if (endpoint) {
    return endpoint
      .replace(/\{sendKey\}/g, encodedSendKey)
      .replace(/\{uid\}/g, uid);
  }

  if (uid) {
    return `https://${uid}.push.ft07.com/send/${encodedSendKey}.send`;
  }

  return `https://sctapi.ftqq.com/${encodedSendKey}.send`;
}

function formatServerChanContent(notice: NormalizedNotice): string {
  const lines = [
    `**级别**：${notice.level.toUpperCase()}`,
    `**时间**：${notice.timestamp.toISOString()}`,
  ];

  if (notice.source) {
    lines.push(`**来源**：${notice.source}`);
  }

  lines.push('', notice.content);
  return lines.join('\n');
}
