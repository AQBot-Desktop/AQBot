import { useCallback, useState } from 'react';
import {
  displayCustomColumnWidthPx,
  multiModelColumnWidthKey,
  type MultiModelColumnLayoutView,
} from '@/lib/multiModelColumnLayout';
import { useMultiModelColumnLayoutStore } from '@/stores';

export function useMultiModelColumnWidth(view: MultiModelColumnLayoutView) {
  const layout = useMultiModelColumnLayoutStore((state) => state.layout);
  const setColumnWidth = useMultiModelColumnLayoutStore((state) => state.setColumnWidth);
  const [previewWidths, setPreviewWidths] = useState<Record<string, number>>({});
  const widthMode = view === 'popout' ? layout.popoutWidthMode : layout.mainWidthMode;
  const layoutMode = Object.keys(previewWidths).length > 0 ? 'scroll' : widthMode;

  const resolvedWidthPx = useCallback((
    providerId: string | null | undefined,
    modelId: string | null | undefined,
    containerWidthPx: number,
  ) => {
    const key = multiModelColumnWidthKey(providerId, modelId);
    if (!key) return undefined;
    const source = previewWidths[key] ?? (layoutMode === 'scroll' ? layout.columnWidths[key] : undefined);
    if (source == null) return undefined;
    return displayCustomColumnWidthPx(source, containerWidthPx);
  }, [layout.columnWidths, layoutMode, previewWidths]);

  const previewWidth = useCallback((
    providerId: string,
    modelId: string,
    widthPx: number,
  ) => {
    const key = multiModelColumnWidthKey(providerId, modelId);
    if (!key) return;
    setPreviewWidths((current) => ({ ...current, [key]: widthPx }));
  }, []);

  const clearPreview = useCallback((providerId: string, modelId: string) => {
    const key = multiModelColumnWidthKey(providerId, modelId);
    if (!key) return;
    setPreviewWidths((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const commitWidth = useCallback(async (
    providerId: string,
    modelId: string,
    widthPx: number | null,
  ) => {
    await setColumnWidth({ view, providerId, modelId, widthPx });
    clearPreview(providerId, modelId);
  }, [clearPreview, setColumnWidth, view]);

  return {
    widthMode,
    layoutMode,
    resolvedWidthPx,
    previewWidth,
    clearPreview,
    commitWidth,
  };
}
