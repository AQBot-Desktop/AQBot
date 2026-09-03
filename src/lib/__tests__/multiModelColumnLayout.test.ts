import { describe, expect, it } from 'vitest';
import {
  MULTI_MODEL_COLUMN_CUSTOM_CLASS,
  MULTI_MODEL_COLUMN_CUSTOM_MIN_WIDTH_PX,
  MULTI_MODEL_COLUMN_FIT_CLASS,
  MULTI_MODEL_COLUMN_MIN_WIDTH_PX,
  clampCustomColumnWidthPx,
  displayCustomColumnWidthPx,
  multiModelColumnWidthKey,
  multiModelColumnWidthSettingKey,
  nextLaneScrollOffset,
  normalizeMultiModelSideBySideWidthMode,
  parseMultiModelColumnWidthSettingKey,
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

describe('per-model column width helpers', () => {
  it('keys widths by provider and model so same model ids stay isolated', () => {
    expect(multiModelColumnWidthKey('openai', 'gpt-4.1')).toBe('openai:gpt-4.1');
    expect(multiModelColumnWidthKey('anthropic', 'gpt-4.1')).toBe('anthropic:gpt-4.1');
    expect(multiModelColumnWidthSettingKey('openai', 'gpt-4.1'))
      .toBe('multi_model_column_width:openai:gpt-4.1');
    expect(parseMultiModelColumnWidthSettingKey('multi_model_column_width:openai:gpt-4.1'))
      .toEqual({ providerId: 'openai', modelId: 'gpt-4.1' });
    expect(multiModelColumnWidthKey(null, 'gpt-4.1')).toBeNull();
  });

  it('clamps custom widths and shrinks display without changing the saved preference', () => {
    expect(clampCustomColumnWidthPx(480)).toBe(480);
    expect(clampCustomColumnWidthPx(120)).toBe(MULTI_MODEL_COLUMN_CUSTOM_MIN_WIDTH_PX);
    expect(displayCustomColumnWidthPx(800, 600)).toBe(600);
    expect(displayCustomColumnWidthPx(800, 900)).toBe(800);
  });

  it('uses custom pixel width in scroll mode without the default two-column class', () => {
    const layout = sideBySideColumnLayout(3, 'scroll', 640);
    expect(layout.className).toBe(MULTI_MODEL_COLUMN_CUSTOM_CLASS);
    expect(layout.style.flex).toBe('0 0 640px');
    expect(layout.style.width).toBe(640);
    expect(JSON.stringify(layout)).not.toContain(String(MULTI_MODEL_COLUMN_MIN_WIDTH_PX));
  });

  it('ignores custom width while fit mode is active', () => {
    const layout = sideBySideColumnLayout(3, 'fit', 640);
    expect(layout.className).toBe(MULTI_MODEL_COLUMN_FIT_CLASS);
    expect(layout.style.flex).toBe('1 1 0');
  });

  it('pages to the next actual column edge instead of the first column width', () => {
    expect(nextLaneScrollOffset([0, 500, 900], 0, 1)).toBe(500);
    expect(nextLaneScrollOffset([0, 500, 900], 500, 1)).toBe(900);
    expect(nextLaneScrollOffset([0, 500, 900], 500, -1)).toBe(0);
    expect(nextLaneScrollOffset([0, 500, 900], 20, -1)).toBe(0);
  });
});
