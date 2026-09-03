import type { CSSProperties } from 'react';
import { getModelVersionGroupKey } from '@/lib/chatMultiModel';
import type { MultiModelSideBySideWidthMode } from '@/types';

export type { MultiModelSideBySideWidthMode };
export type MultiModelColumnLayoutView = 'main' | 'popout';

export const MULTI_MODEL_COLUMN_MIN_WIDTH_PX = 420;
export const MULTI_MODEL_COLUMN_CUSTOM_MIN_WIDTH_PX = 320;
export const MULTI_MODEL_COLUMN_CUSTOM_MAX_WIDTH_PX = 10000;
export const MULTI_MODEL_VISIBLE_COLUMNS = 2;
export const MULTI_MODEL_COLUMN_GAP_PX = 12;
export const MULTI_MODEL_COLUMN_RESIZE_GUTTER_PX = 8;
export const MULTI_MODEL_COLUMN_CLASS = 'aqbot-multi-model-card';
export const MULTI_MODEL_COLUMN_FIT_CLASS = 'aqbot-multi-model-card-fit';
export const MULTI_MODEL_COLUMN_CUSTOM_CLASS = 'aqbot-multi-model-card-custom';
export const MULTI_MODEL_COLUMN_WIDTH_SETTING_PREFIX = 'multi_model_column_width:';
export const MULTI_MODEL_MAIN_WIDTH_MODE_KEY = 'multi_model_side_by_side_width_mode';
export const MULTI_MODEL_POPOUT_WIDTH_MODE_KEY = 'multi_model_popout_side_by_side_width_mode';

export interface MultiModelColumnLayout {
  mainWidthMode: MultiModelSideBySideWidthMode;
  popoutWidthMode: MultiModelSideBySideWidthMode;
  columnWidths: Record<string, number>;
}

export function emptyMultiModelColumnLayout(): MultiModelColumnLayout {
  return {
    mainWidthMode: 'scroll',
    popoutWidthMode: 'scroll',
    columnWidths: {},
  };
}

export function normalizeMultiModelSideBySideWidthMode(
  value: unknown,
): MultiModelSideBySideWidthMode {
  return value === 'fit' ? 'fit' : 'scroll';
}

export function normalizeMultiModelColumnLayoutView(
  value: unknown,
): MultiModelColumnLayoutView {
  return value === 'popout' ? 'popout' : 'main';
}

export function multiModelColumnWidthKey(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): string | null {
  if (!providerId || !modelId) return null;
  return getModelVersionGroupKey(providerId, modelId);
}

export function multiModelColumnWidthSettingKey(
  providerId: string,
  modelId: string,
): string {
  return `${MULTI_MODEL_COLUMN_WIDTH_SETTING_PREFIX}${getModelVersionGroupKey(providerId, modelId)}`;
}

export function parseMultiModelColumnWidthSettingKey(
  key: string,
): { providerId: string; modelId: string } | null {
  if (!key.startsWith(MULTI_MODEL_COLUMN_WIDTH_SETTING_PREFIX)) return null;
  const rest = key.slice(MULTI_MODEL_COLUMN_WIDTH_SETTING_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    providerId: rest.slice(0, separator),
    modelId: rest.slice(separator + 1),
  };
}

export function clampCustomColumnWidthPx(widthPx: number): number {
  if (!Number.isFinite(widthPx)) {
    throw new Error('column width must be a finite number');
  }
  return Math.min(
    MULTI_MODEL_COLUMN_CUSTOM_MAX_WIDTH_PX,
    Math.max(MULTI_MODEL_COLUMN_CUSTOM_MIN_WIDTH_PX, Math.round(widthPx)),
  );
}

export function displayCustomColumnWidthPx(
  savedWidthPx: number,
  containerWidthPx: number,
): number {
  const clamped = clampCustomColumnWidthPx(savedWidthPx);
  if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) return clamped;
  return Math.min(
    clamped,
    Math.max(MULTI_MODEL_COLUMN_CUSTOM_MIN_WIDTH_PX, Math.floor(containerWidthPx)),
  );
}

export function nextLaneScrollOffset(
  columnOffsets: readonly number[],
  currentScrollLeft: number,
  direction: -1 | 1,
): number {
  if (columnOffsets.length === 0) return currentScrollLeft;
  if (direction > 0) {
    const next = columnOffsets.find((offset) => offset > currentScrollLeft + 1);
    return next ?? columnOffsets[columnOffsets.length - 1] ?? currentScrollLeft;
  }
  const previous = [...columnOffsets]
    .reverse()
    .find((offset) => offset < currentScrollLeft - 1);
  return previous ?? columnOffsets[0] ?? 0;
}

export function sideBySideColumnLayout(
  columnCount: number,
  widthMode: MultiModelSideBySideWidthMode = 'scroll',
  customWidthPx?: number,
): {
  className?: string;
  style: CSSProperties;
} {
  if (columnCount <= 1 && customWidthPx == null) {
    return {
      className: undefined,
      style: {
        flex: '1 1 auto',
        width: '100%',
        minWidth: 0,
      },
    };
  }

  if (widthMode === 'fit') {
    return {
      className: MULTI_MODEL_COLUMN_FIT_CLASS,
      style: {
        flex: '1 1 0',
        minWidth: 0,
        width: 'auto',
      },
    };
  }

  if (customWidthPx != null) {
    const width = clampCustomColumnWidthPx(customWidthPx);
    return {
      className: MULTI_MODEL_COLUMN_CUSTOM_CLASS,
      style: {
        flex: `0 0 ${width}px`,
        width,
        minWidth: Math.min(MULTI_MODEL_COLUMN_CUSTOM_MIN_WIDTH_PX, width),
        maxWidth: '100%',
      },
    };
  }

  return {
    className: MULTI_MODEL_COLUMN_CLASS,
    style: {
      flex: '0 0 auto',
      minWidth: MULTI_MODEL_COLUMN_MIN_WIDTH_PX,
    },
  };
}

export function sideBySideTrackStyle(
  widthMode: MultiModelSideBySideWidthMode,
  gap: number = MULTI_MODEL_COLUMN_GAP_PX,
): CSSProperties {
  if (widthMode === 'fit') {
    return {
      display: 'flex',
      gap,
      width: '100%',
      minWidth: 0,
      alignItems: 'stretch',
    };
  }

  return {
    display: 'flex',
    gap,
    minWidth: '100%',
    width: 'max-content',
    alignItems: 'stretch',
  };
}
