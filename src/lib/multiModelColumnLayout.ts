import type { CSSProperties } from 'react';

export const MULTI_MODEL_COLUMN_MIN_WIDTH_PX = 420;
export const MULTI_MODEL_VISIBLE_COLUMNS = 2;
export const MULTI_MODEL_COLUMN_GAP_PX = 12;
export const MULTI_MODEL_COLUMN_CLASS = 'aqbot-multi-model-card';

export function sideBySideColumnLayout(columnCount: number): {
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

  return {
    className: MULTI_MODEL_COLUMN_CLASS,
    style: {
      flex: '0 0 auto',
      minWidth: MULTI_MODEL_COLUMN_MIN_WIDTH_PX,
    },
  };
}
