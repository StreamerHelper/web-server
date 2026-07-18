const VIDEO_SEGMENT_FILENAME_PATTERN =
  /segment_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mkv$/;

export const VIDEO_SEGMENT_TIME_ZONE = 'UTC';
export const DEFAULT_APPLICATION_TIME_ZONE = 'Asia/Shanghai';

/**
 * Video segment filenames are a storage contract: their calendar fields are
 * always UTC, regardless of the host or application display timezone.
 */
export function parseVideoSegmentDate(value?: string): Date | undefined {
  const match = value?.match(VIDEO_SEGMENT_FILENAME_PATTERN);
  if (!match) {
    return undefined;
  }

  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
  ] = match;
  const year = Number(yearValue);
  const month = Number(monthValue) - 1;
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return undefined;
  }

  return date;
}

export function parseVideoSegmentTimestamp(value?: string): number | null {
  return parseVideoSegmentDate(value)?.getTime() ?? null;
}

export function getApplicationTimeZone(): string {
  return process.env.TZ?.trim() || DEFAULT_APPLICATION_TIME_ZONE;
}

export function formatDateTimeInTimeZone(
  date: Date,
  timeZone = getApplicationTimeZone()
): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = new Map(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return `${parts.get('year')}-${parts.get('month')}-${parts.get(
    'day'
  )} ${parts.get('hour')}:${parts.get('minute')}`;
}
