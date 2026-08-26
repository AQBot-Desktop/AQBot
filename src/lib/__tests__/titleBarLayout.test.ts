import { describe, expect, it } from 'vitest';
import {
  MACOS_TRAFFIC_LIGHT_INSET_PX,
  TITLEBAR_EDGE_INSET_PX,
  titleBarPaddingLeft,
} from '../titleBarLayout';

describe('titleBarPaddingLeft', () => {
  it('keeps a compact inset on Windows in every window state', () => {
    expect(titleBarPaddingLeft({ isWindows: true, isFullscreen: false })).toBe(TITLEBAR_EDGE_INSET_PX);
    expect(titleBarPaddingLeft({ isWindows: true, isFullscreen: true })).toBe(TITLEBAR_EDGE_INSET_PX);
  });

  it('reserves macOS traffic-light space only while the window is not fullscreen', () => {
    expect(titleBarPaddingLeft({ isWindows: false, isFullscreen: false })).toBe(MACOS_TRAFFIC_LIGHT_INSET_PX);
    expect(titleBarPaddingLeft({ isWindows: false, isFullscreen: true })).toBe(TITLEBAR_EDGE_INSET_PX);
  });
});
