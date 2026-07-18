import {
  formatDateTimeInTimeZone,
  parseVideoSegmentDate,
  parseVideoSegmentTimestamp,
} from '../../src/utils/video-segment-time';

describe('video segment time contract', () => {
  it('parses filename calendar fields as UTC', () => {
    const key = 'raw/job/video/segment_20260717_190159.mkv';

    expect(parseVideoSegmentDate(key)?.toISOString()).toBe(
      '2026-07-17T19:01:59.000Z'
    );
    expect(parseVideoSegmentTimestamp(key)).toBe(
      Date.UTC(2026, 6, 17, 19, 1, 59)
    );
  });

  it('formats the same instant in the configured application timezone', () => {
    const date = parseVideoSegmentDate('segment_20260717_190159.mkv') as Date;

    expect(formatDateTimeInTimeZone(date, 'UTC')).toBe('2026-07-17 19:01');
    expect(formatDateTimeInTimeZone(date, 'Asia/Shanghai')).toBe(
      '2026-07-18 03:01'
    );
  });

  it('rejects invalid or ambiguous segment filenames', () => {
    expect(
      parseVideoSegmentDate('segment_20260230_120000.mkv')
    ).toBeUndefined();
    expect(parseVideoSegmentDate('part_20260717_190159.mkv')).toBeUndefined();
  });
});
