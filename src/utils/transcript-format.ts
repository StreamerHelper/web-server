import { TranscriptMessage } from '../interface/data';

export type TranscriptExportFormat = 'txt' | 'json' | 'jsonl' | 'srt' | 'vtt';

export function formatTranscriptMessages(
  messages: TranscriptMessage[],
  format: TranscriptExportFormat,
  durationMs = 0,
  offsetMs = 0
): string {
  const normalized = messages
    .filter(message => message.text?.trim())
    .map(message => ({
      ...message,
      timestamp: Math.max(0, message.timestamp - offsetMs),
    }))
    .sort((left, right) => left.timestamp - right.timestamp);

  if (format === 'txt') {
    return `${normalized.map(message => message.text.trim()).join('\n')}\n`;
  }
  if (format === 'json') {
    return `${JSON.stringify(normalized, null, 2)}\n`;
  }
  if (format === 'jsonl') {
    return `${normalized.map(message => JSON.stringify(message)).join('\n')}\n`;
  }
  if (format === 'srt') {
    return formatSrt(normalized, durationMs ? durationMs - offsetMs : 0);
  }
  if (format === 'vtt') {
    return formatVtt(normalized, durationMs ? durationMs - offsetMs : 0);
  }

  throw new Error(`Unsupported transcript export format: ${format}`);
}

function formatSrt(messages: TranscriptMessage[], durationMs: number): string {
  return messages
    .map((message, index) => {
      const endMs = getMessageEndMs(messages, index, durationMs);
      return [
        String(index + 1),
        `${formatTimestamp(message.timestamp, ',')} --> ${formatTimestamp(
          endMs,
          ','
        )}`,
        message.text.trim(),
        '',
      ].join('\n');
    })
    .join('\n');
}

function formatVtt(messages: TranscriptMessage[], durationMs: number): string {
  const body = messages
    .map((message, index) => {
      const endMs = getMessageEndMs(messages, index, durationMs);
      return [
        `${formatTimestamp(message.timestamp, '.')} --> ${formatTimestamp(
          endMs,
          '.'
        )}`,
        message.text.trim(),
        '',
      ].join('\n');
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

function getMessageEndMs(
  messages: TranscriptMessage[],
  index: number,
  durationMs: number
): number {
  const current = messages[index];
  const rawDuration = current.raw?.chunkDurationMs;
  const duration =
    typeof rawDuration === 'number' && Number.isFinite(rawDuration)
      ? rawDuration
      : 0;
  if (duration > 0) {
    return current.timestamp + duration;
  }

  const next = messages[index + 1];
  if (next) {
    return Math.max(current.timestamp + 500, next.timestamp);
  }
  return Math.max(
    current.timestamp + 500,
    durationMs || current.timestamp + 3000
  );
}

function formatTimestamp(ms: number, separator: ',' | '.'): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${String(
    millis
  ).padStart(3, '0')}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
