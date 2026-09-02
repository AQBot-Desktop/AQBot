import { describe, expect, it } from 'vitest';
import {
  MULTI_MODEL_COLUMN_FIT_CLASS,
  MULTI_MODEL_COLUMN_MIN_WIDTH_PX,
  normalizeMultiModelSideBySideWidthMode,
  sideBySideColumnLayout,
  sideBySideTrackStyle,
} from '../multiModelColumnLayout';

describe('normalizeMultiModelSideBySideWidthMode', () => {
  it('keeps fit and defaults everything else to scroll', () => {
    expect(normalizeMultiModelSideBySideWidthMode('fit')).toBe('fit');
    expect(normalizeMultiModelSideBySideWidthMode('scroll')).toBe('scroll');
    expect(normalizeMultiModelSideBySideWidthMode(undefined)).toBe('scroll');
    expect(normalizeMultiModelSideBySideWidthMode('grid')).toBe('scroll');
  });
});

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
    expect(sideBySideColumnLayout(1, 'fit')).toEqual(sideBySideColumnLayout(1, 'scroll'));
  });

  it('keeps three or more columns at a readable two-column width instead of 1/n', () => {
    const layout = sideBySideColumnLayout(4);
    expect(layout.className).toBe('aqbot-multi-model-card');
    expect(layout.style.flex).toBe('0 0 auto');
    expect(layout.style.minWidth).toBe(MULTI_MODEL_COLUMN_MIN_WIDTH_PX);
    expect(layout.style.width).toBeUndefined();
    expect(JSON.stringify(layout)).not.toContain('100%');
  });

  it('lets fit mode share the workspace equally without a readable-width floor', () => {
    const layout = sideBySideColumnLayout(4, 'fit');
    expect(layout.className).toBe(MULTI_MODEL_COLUMN_FIT_CLASS);
    expect(layout.style.flex).toBe('1 1 0');
    expect(layout.style.minWidth).toBe(0);
    expect(layout.style.width).toBe('auto');
    expect(JSON.stringify(layout)).not.toContain(String(MULTI_MODEL_COLUMN_MIN_WIDTH_PX));
  });
});

describe('sideBySideTrackStyle', () => {
  it('keeps a max-content track for scroll and a full-width track for fit', () => {
    expect(sideBySideTrackStyle('scroll')).toEqual({
      display: 'flex',
      gap: 12,
      minWidth: '100%',
      width: 'max-content',
      alignItems: 'stretch',
    });
    expect(sideBySideTrackStyle('fit')).toEqual({
      display: 'flex',
      gap: 12,
      width: '100%',
      minWidth: 0,
      alignItems: 'stretch',
    });
  });

  it('lets independent-window lanes drop the column gap', () => {
    expect(sideBySideTrackStyle('fit', 0).gap).toBe(0);
    expect(sideBySideTrackStyle('scroll', 0).gap).toBe(0);
  });
});
