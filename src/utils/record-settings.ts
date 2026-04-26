import {
  RecordingAutoDeleteSettings,
  RecordingQuality,
} from '../interface';

const RECORDING_QUALITIES = new Set<RecordingQuality>([
  'low',
  'medium',
  'high',
]);

const MIN_DELETE_DELAY_MINUTES = 1;
const MAX_DELETE_DELAY_MINUTES = 30 * 24 * 60;
const DEFAULT_DELETE_DELAY_MINUTES = 6 * 60;

export function resolveRecordingQuality(
  quality?: RecordingQuality | string | null
): RecordingQuality {
  return RECORDING_QUALITIES.has(quality as RecordingQuality)
    ? (quality as RecordingQuality)
    : 'high';
}

export function normalizeAutoDeleteSettings(
  settings?: RecordingAutoDeleteSettings | null
): RecordingAutoDeleteSettings | undefined {
  if (!settings?.enabled) {
    return undefined;
  }

  const delayMinutes = Number.isFinite(settings.delayMinutes)
    ? Number(settings.delayMinutes)
    : DEFAULT_DELETE_DELAY_MINUTES;

  return {
    enabled: true,
    delayMinutes: Math.min(
      MAX_DELETE_DELAY_MINUTES,
      Math.max(MIN_DELETE_DELAY_MINUTES, Math.round(delayMinutes))
    ),
  };
}
