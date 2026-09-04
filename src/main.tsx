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

async function bootstrap() {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('AQBot root element #root was not found');
  }

  const windowLabel = '__TAURI_INTERNALS__' in window
    ? (await import('@tauri-apps/api/webviewWindow')).getCurrentWebviewWindow().label
    : 'main';
  setCurrentWindowLabel(windowLabel);
  if (frontendKindForWindow(windowLabel) === 'capture-overlay') {
    const { CaptureOverlay } = await import('./capture-overlay/CaptureOverlay');
    ReactDOM.createRoot(rootElement).render(<CaptureOverlay />);
    void writeStartupDiagnostic('info', 'AQBot capture overlay frontend rendered');
    return;
  }
  if (frontendKindForWindow(windowLabel) === 'selection-toolbar') {
    const { SelectionToolbarRoot } = await import('./selection-toolbar/SelectionToolbarApp');
    ReactDOM.createRoot(rootElement).render(<SelectionToolbarRoot />);
    void writeStartupDiagnostic('info', 'AQBot selection toolbar frontend rendered');
    return;
  }

  const { default: AppRoot } = await import('./App');
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <AppRoot />
    </React.StrictMode>,
  );
  void writeStartupDiagnostic('info', 'AQBot frontend bootstrap rendered');
}

void bootstrap().catch((error) => {
  const rootElement = document.getElementById('root');
  if (rootElement) {
    renderStartupError(rootElement, error);
  }
  void writeStartupDiagnostic(
    'error',
    `AQBot frontend bootstrap failed: ${formatStartupError(error)}`,
  );
});
