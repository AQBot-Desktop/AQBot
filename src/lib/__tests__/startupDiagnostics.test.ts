import { describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import {
  formatStartupError,
  installStartupDiagnostics,
  renderStartupError,
} from '@/lib/startupDiagnostics';

describe('startupDiagnostics', () => {
  it('formats errors with stack or message details', () => {
    const error = new Error('module failed');

    expect(formatStartupError(error)).toContain('module failed');
  });

  it('preserves the original cause in wrapped startup failures', () => {
    const error = new Error('module import failed');
    Reflect.set(error, 'cause', new Error('source file unavailable'));
    expect(formatStartupError(error)).toContain('module import failed');
    expect(formatStartupError(error)).toContain('source file unavailable');
  });

  it('renders a visible startup error panel with log instructions', () => {
    const root = document.createElement('div');

    renderStartupError(root, new Error('bootstrap failed'));

    expect(root.textContent).toContain(i18n.t('startup.failed'));
    expect(root.textContent).toContain('bootstrap failed');
    expect(root.textContent).toContain('AQBOT_LOG_FILE');
  });

  it('logs window startup errors through the provided writer', () => {
    const writeLog = vi.fn();
    const cleanup = installStartupDiagnostics(writeLog);
    const event = new ErrorEvent('error', {
      message: 'render exploded',
      filename: 'index.js',
      lineno: 10,
      colno: 20,
    });

    window.dispatchEvent(event);
    cleanup();

    expect(writeLog).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('render exploded'),
    );
  });
});
