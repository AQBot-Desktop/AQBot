import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();

describe('bootstrap failure handling', () => {
  beforeEach(() => {
    vi.resetModules();
    // React 19 deliberately rethrows errors inside act instead of invoking onUncaughtError.
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false);
    invoke.mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = '<div id="root"></div>';
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke,
      transformCallback: () => 1,
    } });
  });
  afterEach(() => {
    document.body.replaceChildren();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  });

  it.each(['import', 'render'])('logs %s failures and actually shows the standalone error page', async (phase) => {
    vi.doMock('../App', () => {
      if (phase === 'import') throw new Error('application module unavailable');
      return { default: () => { throw new Error('first render failed'); } };
    });
    await import('../main');
    await waitFor(() => expect(document.querySelector('#root pre')).not.toBeNull());
    expect(document.querySelector('#root')?.textContent).toContain(phase === 'import'
      ? 'application module unavailable' : 'first render failed');
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:window|show', { label: 'main' }, undefined));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('report_startup_presented', { kind: 'error' }, undefined));
    expect(invoke).not.toHaveBeenCalledWith('report_startup_presented', { kind: 'app' }, undefined);
    expect(invoke).toHaveBeenCalledWith('write_diagnostic_log', expect.objectContaining({
      level: 'error', message: expect.stringContaining('frontend bootstrap failed'),
    }), undefined);
  });
});
