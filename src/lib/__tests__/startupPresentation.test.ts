import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
let label = 'main';
const callbacks: Array<(event: object) => void> = [];

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset().mockImplementation(async (command: string) => command === 'present_startup_window' ? 'visible' : undefined);
  label = 'main';
  callbacks.length = 0;
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {
    metadata: { get currentWindow() { return { label }; }, get currentWebview() { return { label }; } },
    invoke,
    transformCallback: (callback: (event: object) => void) => callbacks.push(callback),
  } });
});
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });

describe('startup native presentation', () => {
  it.each(['hidden', 'minimized'])('accepts intentional %s startup without showing or focusing from the frontend', async (mode) => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'present_startup_window') return mode;
    });
    const { presentStartupWindow } = await import('../startupDiagnostics');
    await presentStartupWindow('loading');
    expect(invoke).not.toHaveBeenCalledWith('report_startup_presented', expect.anything(), undefined);
    await presentStartupWindow('app');
    expect(invoke).toHaveBeenCalledWith('present_startup_window', { forceVisible: false }, undefined);
    expect(invoke).not.toHaveBeenCalledWith('plugin:window|show', expect.anything(), undefined);
    expect(invoke).not.toHaveBeenCalledWith('plugin:window|set_focus', expect.anything(), undefined);
    expect(invoke).toHaveBeenCalledWith('report_startup_presented', { kind: 'app' }, undefined);
    expect(invoke).not.toHaveBeenCalledWith('report_startup_presented', { kind: 'error' }, undefined);
  });

  it.each(['hidden', 'minimized'])('can present an actual error after a successful %s startup', async (mode) => {
    invoke.mockImplementation(async (command: string, args?: { forceVisible?: boolean }) => {
      if (command === 'present_startup_window') return args?.forceVisible ? 'visible' : mode;
    });
    const { presentStartupWindow } = await import('../startupDiagnostics');
    expect(await presentStartupWindow('app')).toBe(mode === 'minimized');
    expect(await presentStartupWindow('error')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('present_startup_window', { forceVisible: true }, undefined);
    expect(invoke).toHaveBeenCalledWith('report_startup_presented', { kind: 'error' }, undefined);
  });

  it('requests presentation once per WebView lifetime and confirms the committed main interface', async () => {
    const { presentStartupWindow } = await import('../startupDiagnostics');
    await presentStartupWindow('loading');
    expect(invoke).not.toHaveBeenCalledWith('report_startup_presented', expect.anything(), undefined);
    await Promise.all([presentStartupWindow('app'), presentStartupWindow('app')]);
    expect(invoke.mock.calls.filter(([command]) => command === 'present_startup_window')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('report_startup_presented', { kind: 'app' }, undefined);
    vi.resetModules();
    await (await import('../startupDiagnostics')).presentStartupWindow('app');
    expect(invoke.mock.calls.filter(([command]) => command === 'present_startup_window')).toHaveLength(2);
  });

  it('persists a failed show and asks the backend to diagnose it without logging success', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'present_startup_window') throw new Error('native show failed');
    });
    const { presentStartupWindow } = await import('../startupDiagnostics');
    expect(await presentStartupWindow('loading')).toBe(false);
    expect(await presentStartupWindow('app')).toBe(false);
    expect(invoke).toHaveBeenCalledWith('report_startup_presented', { kind: 'error' }, undefined);
    expect(invoke).toHaveBeenCalledWith('write_diagnostic_log', expect.objectContaining({
      level: 'error', message: expect.stringContaining('native show failed'),
    }), undefined);
    expect(invoke.mock.calls.filter(([command]) => command === 'present_startup_window')).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith('report_startup_presented', { kind: 'app' }, undefined);
  });

  it('keeps popout readiness independent of focus failures', async () => {
    label = 'conversation-popout:conversation-1';
    invoke.mockImplementation(async (command: string) => {
      if (command === 'plugin:window|set_focus') throw new Error('focus denied');
    });
    const { presentStartupWindow } = await import('../startupDiagnostics');
    expect(await presentStartupWindow('app')).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('report_startup_presented', expect.anything(), undefined);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('write_diagnostic_log', expect.objectContaining({
      level: 'warn', message: expect.stringContaining('focus denied'),
    }), undefined));
  });

  it.each(['zh-CN', 'en-US', 'ar'])('renders translated errors before App imports and shows the native window (%s)', async (language) => {
    const { default: i18n } = await import('@/i18n');
    await i18n.changeLanguage(language);
    const { renderStartupError } = await import('../startupDiagnostics');
    const root = document.createElement('div');
    renderStartupError(root, new Error('dynamic import failed'));
    expect(root.querySelector('h1')?.textContent).toBe(i18n.t('startup.failed'));
    expect(root.firstElementChild?.getAttribute('dir')).toBe(i18n.dir());
    expect(root.textContent).toContain('dynamic import failed');
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('present_startup_window', { forceVisible: true }, undefined));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('report_startup_presented', { kind: 'error' }, undefined));
  });

  it('keeps native close working after an uncaught error unmounts React', async () => {
    const { renderStartupError } = await import('../startupDiagnostics');
    renderStartupError(document.createElement('div'), new Error('render failed'));
    await waitFor(() => expect(callbacks.length).toBe(1));
    callbacks[0]({ event: 'app-close-requested', payload: null, id: 1 });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('force_quit', {}, undefined));
  });

  it.each(['capture-overlay', 'selection-toolbar', 'unknown-window'])('does not reveal auxiliary error windows (%s)', async (windowLabel) => {
    label = windowLabel;
    const { presentStartupWindow } = await import('../startupDiagnostics');
    expect(await presentStartupWindow('error')).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('plugin:window|show', expect.anything(), undefined);
    expect(invoke).not.toHaveBeenCalledWith('report_startup_presented', expect.anything(), undefined);
  });
});
