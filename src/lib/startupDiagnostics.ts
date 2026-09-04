import i18n from '@/i18n';
import { frontendKindForWindow } from '@/lib/windowKind';

export type StartupLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type StartupDiagnosticWriter = (
  level: StartupLogLevel,
  message: string,
) => void | Promise<void>;

const MAX_DIAGNOSTIC_TEXT_LENGTH = 8 * 1024;
// A WebView reload recreates this module; StrictMode and React remounts do not.
const presentations = new Map<'loading' | 'app' | 'error', Promise<boolean>>();
let windowShown: Promise<boolean> | undefined;
let errorCloseListener: Promise<void> | undefined;

export function formatStartupError(reason: unknown): string {
  if (reason instanceof Error) {
    const chain: string[] = [];
    const seen = new Set<Error>();
    let current: unknown = reason;
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      chain.push(current.stack || current.message || current.name);
      current = Reflect.get(current, 'cause');
    }
    if (current !== undefined && !(current instanceof Error)) chain.push(String(current));
    return truncateDiagnosticText(chain.join('\nCaused by: '));
  }
  if (typeof reason === 'string') {
    return truncateDiagnosticText(reason);
  }
  try {
    return truncateDiagnosticText(JSON.stringify(reason) ?? String(reason));
  } catch {
    return String(reason);
  }
}

export async function writeStartupDiagnostic(
  level: StartupLogLevel,
  message: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_diagnostic_log', {
      level,
      message: truncateDiagnosticText(message),
    });
  } catch (error) {
    // Keep startup progressing if its diagnostic transport fails, but retain evidence.
    console.error('Failed to write startup diagnostic:', message, error);
  }
}

/** Called after React commits, or after the standalone error page is attached. */
export function presentStartupWindow(kind: 'loading' | 'app' | 'error'): Promise<boolean> {
  if (!isTauriRuntime()) return Promise.resolve(false);
  const existing = presentations.get(kind);
  if (existing) return existing;
  const presentation = confirmStartupPresentation(kind);
  presentations.set(kind, presentation);
  return presentation;
}

async function confirmStartupPresentation(kind: 'loading' | 'app' | 'error'): Promise<boolean> {
  const shown = await (windowShown ??= showStartupWindow());
  if (shown && kind === 'loading') return true;
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    if (getCurrentWebviewWindow().label === 'main') {
      if (kind === 'error') listenForErrorWindowClose();
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('report_startup_presented', { kind: shown ? kind : 'error' });
    }
    return shown;
  } catch (error) {
    void writeStartupDiagnostic('error', `frontend presentation confirmation failed: ${formatStartupError(error)}`);
    return false;
  }
}

async function showStartupWindow(): Promise<boolean> {
  const startedAt = performance.now();
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const nativeWindow = getCurrentWebviewWindow();
    if (nativeWindow.label !== 'main' && frontendKindForWindow(nativeWindow.label) !== 'conversation-popout') return false;
    void writeStartupDiagnostic('info', `frontend window_show begin window=${nativeWindow.label}`);
    await nativeWindow.show();
    void writeStartupDiagnostic('info', `frontend window_show complete elapsed_ms=${Math.round(performance.now() - startedAt)}`);
    void nativeWindow.setFocus().catch((error) => {
      void writeStartupDiagnostic('warn', `frontend window_focus failed: ${formatStartupError(error)}`);
    });
    return true;
  } catch (error) {
    // Dispatch the original failure first; a stalled logger must not block native diagnosis.
    void writeStartupDiagnostic('error', `frontend window_show failed: ${formatStartupError(error)}`);
    return false;
  }
}

export async function closeStartupWindow(): Promise<void> {
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    await getCurrentWebviewWindow().close();
  } catch (error) {
    void writeStartupDiagnostic('error', `frontend startup close failed: ${formatStartupError(error)}`);
  }
}

function listenForErrorWindowClose(): void {
  errorCloseListener ??= import('@tauri-apps/api/event')
    .then(({ listen }) => listen('app-close-requested', () => {
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('force_quit'))
        .catch((error) => writeStartupDiagnostic('error', `frontend error window close failed: ${formatStartupError(error)}`));
    }))
    .then(() => {})
    .catch((error) => writeStartupDiagnostic('error', `frontend error window close listener failed: ${formatStartupError(error)}`));
}

export function installStartupDiagnostics(
  writeLog: StartupDiagnosticWriter = writeStartupDiagnostic,
): () => void {
  const handleError = (event: ErrorEvent) => {
    void writeLog(
      'error',
      [
        'frontend window error',
        `message=${event.message || '<empty>'}`,
        `filename=${event.filename || '<unknown>'}`,
        `line=${event.lineno || 0}`,
        `column=${event.colno || 0}`,
        event.error ? `error=${formatStartupError(event.error)}` : null,
      ].filter(Boolean).join(' '),
    );
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    void writeLog(
      'error',
      `frontend unhandled rejection: ${formatStartupError(event.reason)}`,
    );
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);

  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  };
}

export function renderStartupError(root: HTMLElement, reason: unknown): void {
  const panel = document.createElement('div');
  panel.lang = i18n.language;
  panel.dir = i18n.dir();
  panel.style.minHeight = '100vh';
  panel.style.boxSizing = 'border-box';
  panel.style.padding = '32px';
  panel.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  panel.style.background = '#111827';
  panel.style.color = '#f9fafb';

  const title = document.createElement('h1');
  title.textContent = i18n.t('startup.failed');
  title.style.margin = '0 0 12px';
  title.style.fontSize = '20px';
  title.style.fontWeight = '600';

  const description = document.createElement('p');
  description.textContent = i18n.t('startup.logInstructions');
  description.style.margin = '0 0 16px';
  description.style.color = '#d1d5db';
  description.style.lineHeight = '1.5';

  const pre = document.createElement('pre');
  pre.textContent = formatStartupError(reason);
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.wordBreak = 'break-word';
  pre.style.padding = '16px';
  pre.style.borderRadius = '8px';
  pre.style.background = '#020617';
  pre.style.color = '#fca5a5';
  pre.style.overflow = 'auto';
  pre.style.maxHeight = '60vh';

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = i18n.t('common.close');
  close.onclick = () => { void closeStartupWindow(); };
  panel.append(title, description, pre, close);
  root.replaceChildren(panel);
  void presentStartupWindow('error');
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function truncateDiagnosticText(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}...<truncated>`;
}
