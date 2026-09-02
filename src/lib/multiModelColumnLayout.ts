import type { CSSProperties } from 'react';
import type { MultiModelSideBySideWidthMode } from '@/types';

export type { MultiModelSideBySideWidthMode };

export const MULTI_MODEL_COLUMN_MIN_WIDTH_PX = 420;
export const MULTI_MODEL_VISIBLE_COLUMNS = 2;
export const MULTI_MODEL_COLUMN_GAP_PX = 12;
export const MULTI_MODEL_COLUMN_CLASS = 'aqbot-multi-model-card';
export const MULTI_MODEL_COLUMN_FIT_CLASS = 'aqbot-multi-model-card-fit';

export function normalizeMultiModelSideBySideWidthMode(
  value: unknown,
): MultiModelSideBySideWidthMode {
  return value === 'fit' ? 'fit' : 'scroll';
}

export function sideBySideColumnLayout(
  columnCount: number,
  widthMode: MultiModelSideBySideWidthMode = 'scroll',
): {
  className?: string;
  style: CSSProperties;
} {
  if (columnCount <= 1) {
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
