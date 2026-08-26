import { describe, expect, it } from 'vitest';
import {
  MULTI_MODEL_COLUMN_MIN_WIDTH_PX,
  sideBySideColumnLayout,
} from '../multiModelColumnLayout';

describe('sideBySideColumnLayout', () => {
  it('lets a single column fill the workspace', () => {
    expect(sideBySideColumnLayout(1)).toEqual({
      className: undefined,
      style: {
        flex: '1 1 auto',
        width: '100%',
        minWidth: 0,
      },
    });
  });

  it('keeps three or more columns at a readable two-column width instead of 1/n', () => {
    const layout = sideBySideColumnLayout(4);
    expect(layout.className).toBe('aqbot-multi-model-card');
    expect(layout.style.flex).toBe('0 0 auto');
    expect(layout.style.minWidth).toBe(MULTI_MODEL_COLUMN_MIN_WIDTH_PX);
    expect(layout.style.width).toBeUndefined();
    expect(JSON.stringify(layout)).not.toContain('100%');
  });
});
