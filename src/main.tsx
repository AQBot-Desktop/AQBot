import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import {
  formatStartupError,
  installStartupDiagnostics,
  renderStartupError,
  writeStartupDiagnostic,
} from '@/lib/startupDiagnostics';
import { frontendKindForWindow, setCurrentWindowLabel } from '@/lib/windowKind';

// Native context menu prevention is handled by GlobalCopyMenu component.
// It prevents the native menu while providing a custom Copy menu when text is selected.

installStartupDiagnostics();
let reactRoot: ReactDOM.Root | undefined;
let failureQueued = false;

function handleStartupFailure(error: unknown): void {
  void writeStartupDiagnostic('error', `AQBot frontend bootstrap failed: ${formatStartupError(error)}`);
  if (failureQueued) return;
  failureQueued = true;
  // React can report an uncaught render error during its own commit; unmount afterward.
  queueMicrotask(() => {
    reactRoot?.unmount();
    const rootElement = document.getElementById('root');
    if (rootElement) renderStartupError(rootElement, error);
  });
}

async function bootstrap() {
  const startedAt = performance.now();
  void writeStartupDiagnostic('info', 'frontend bootstrap begin');
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('AQBot root element #root was not found');
  }

  const windowLabel = '__TAURI_INTERNALS__' in window
    ? (await import('@tauri-apps/api/webviewWindow')).getCurrentWebviewWindow().label
    : 'main';
  setCurrentWindowLabel(windowLabel);
  reactRoot = ReactDOM.createRoot(rootElement, { onUncaughtError: handleStartupFailure });
  if (frontendKindForWindow(windowLabel) === 'capture-overlay') {
    const { CaptureOverlay } = await import('./capture-overlay/CaptureOverlay');
    reactRoot.render(<CaptureOverlay />);
    void writeStartupDiagnostic('info', 'AQBot capture overlay frontend render scheduled');
    return;
  }
  if (frontendKindForWindow(windowLabel) === 'selection-toolbar') {
    const { SelectionToolbarRoot } = await import('./selection-toolbar/SelectionToolbarApp');
    reactRoot.render(<SelectionToolbarRoot />);
    void writeStartupDiagnostic('info', 'AQBot selection toolbar frontend render scheduled');
    return;
  }

  const { default: AppRoot } = await import('./App');
  reactRoot.render(
    <React.StrictMode>
      <AppRoot />
    </React.StrictMode>,
  );
  void writeStartupDiagnostic('info', `frontend bootstrap render scheduled elapsed_ms=${Math.round(performance.now() - startedAt)}`);
}

void bootstrap().catch(handleStartupFailure);
