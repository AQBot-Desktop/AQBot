import {
  DEFAULT_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS,
  MAX_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS,
  type MultiModelExecutionMode,
} from '@/types';

export function normalizeMultiModelExecutionMode(value: unknown): MultiModelExecutionMode {
  return value === 'sequential' ? 'sequential' : 'parallel';
}

export function normalizeMultiModelSequentialInterval(
  value: number | string | null | undefined,
): number {
  const numericValue = typeof value === 'number'
    ? value
    : Number(value ?? DEFAULT_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS);
  if (!Number.isFinite(numericValue)) return DEFAULT_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS;
  return Math.min(
    MAX_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS,
    Math.max(0, Math.floor(numericValue)),
  );
}
