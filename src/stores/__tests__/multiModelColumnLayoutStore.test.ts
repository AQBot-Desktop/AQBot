import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyMultiModelColumnLayout } from '@/lib/multiModelColumnLayout';

const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const listen = vi.fn<(...args: unknown[]) => Promise<() => void>>(async () => () => {});

vi.mock('@/lib/invoke', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
  listen: (event: string, handler: (payload: unknown) => void) => listen(event, handler),
}));

import { useMultiModelColumnLayoutStore } from '../multiModelColumnLayoutStore';

describe('multiModelColumnLayoutStore', () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockClear();
    useMultiModelColumnLayoutStore.setState({
      layout: emptyMultiModelColumnLayout(),
      loaded: false,
      error: null,
    });
  });

  it('rolls back a failed column width save instead of keeping the optimistic value', async () => {
    useMultiModelColumnLayoutStore.setState({
      layout: {
        ...emptyMultiModelColumnLayout(),
        columnWidths: { 'provider-a:model-a': 480 },
      },
      loaded: true,
      error: null,
    });
    invoke.mockRejectedValue(new Error('save failed'));

    await expect(useMultiModelColumnLayoutStore.getState().setColumnWidth({
      view: 'main',
      providerId: 'provider-b',
      modelId: 'model-b',
      widthPx: 720,
    })).rejects.toThrow('save failed');

    expect(useMultiModelColumnLayoutStore.getState().layout.columnWidths).toEqual({
      'provider-a:model-a': 480,
    });
    expect(useMultiModelColumnLayoutStore.getState().layout.mainWidthMode).toBe('scroll');
  });

  it('keeps a shared width map and only switches the current view to scroll', async () => {
    invoke.mockResolvedValue({
      mainWidthMode: 'scroll',
      popoutWidthMode: 'fit',
      columnWidths: { 'provider-a:model-a': 640 },
    });

    await useMultiModelColumnLayoutStore.getState().setColumnWidth({
      view: 'main',
      providerId: 'provider-a',
      modelId: 'model-a',
      widthPx: 640,
    });

    expect(invoke).toHaveBeenCalledWith('set_multi_model_column_width', {
      view: 'main',
      providerId: 'provider-a',
      modelId: 'model-a',
      widthPx: 640,
    });
    expect(useMultiModelColumnLayoutStore.getState().layout).toEqual({
      mainWidthMode: 'scroll',
      popoutWidthMode: 'fit',
      columnWidths: { 'provider-a:model-a': 640 },
    });
  });
});
