/** Compact inset used on Windows and in macOS native fullscreen. */
export const TITLEBAR_EDGE_INSET_PX = 12;

/** Space reserved for macOS traffic lights in a windowed Overlay title bar. */
export const MACOS_TRAFFIC_LIGHT_INSET_PX = 72;

export function titleBarPaddingLeft(options: {
  isWindows: boolean;
  isFullscreen: boolean;
}): number {
  if (options.isWindows || options.isFullscreen) {
    return TITLEBAR_EDGE_INSET_PX;
  }
  return MACOS_TRAFFIC_LIGHT_INSET_PX;
}
