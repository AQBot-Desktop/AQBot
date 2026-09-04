import { useEffect, useRef } from 'react';
import { useSettingsStore, useMultiModelColumnLayoutStore } from '@/stores';
import { useAcpStore } from '@/stores/acpStore';
import { invoke, isTauri } from '@/lib/invoke';
import { notifyConversationPopoutReady } from '@/lib/conversationPopout';
import { conversationIdFromPopoutLabel, getCurrentWindowLabel } from '@/lib/windowKind';
import { formatStartupError, presentStartupWindow, writeStartupDiagnostic } from '@/lib/startupDiagnostics';

async function runStartupTask(name: string, task: () => void | Promise<void>): Promise<void> {
  const startedAt = performance.now();
  void writeStartupDiagnostic('info', `frontend ${name} begin`);
  try {
    await task();
    void writeStartupDiagnostic('info', `frontend ${name} complete elapsed_ms=${Math.round(performance.now() - startedAt)}`);
  } catch (error) {
    void writeStartupDiagnostic('error', `frontend ${name} failed elapsed_ms=${Math.round(performance.now() - startedAt)}: ${formatStartupError(error)}`);
  }
}

export function useAppStartup(): void {
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const label = getCurrentWindowLabel();
    const conversationId = conversationIdFromPopoutLabel(label);
    void writeStartupDiagnostic('info', `frontend first_commit window=${label}`);
    void presentStartupWindow('loading').then((shown) => {
      if (shown && conversationId) {
        return runStartupTask('popout_ready', () => notifyConversationPopoutReady(conversationId));
      }
    });
    void runStartupTask('acp_bootstrap', () => useAcpStore.getState().warmBootstrap());
    void runStartupTask('column_layout', () => useMultiModelColumnLayoutStore.getState().ensureLoaded());
    void runStartupTask('settings', async () => {
      await useSettingsStore.getState().fetchSettings();
      const { settings, settingsMeta, error } = useSettingsStore.getState();
      // fetchSettings records failures in the store instead of rejecting its promise.
      if (settingsMeta.status !== 'ready') throw new Error(error ?? 'Settings did not reach the ready state');
      if (!isTauri()) return;
      void runStartupTask('native_settings', () => label === 'main'
        ? invoke('apply_startup_settings', {
          alwaysOnTop: settings.always_on_top ?? false,
          closeToTray: settings.minimize_to_tray ?? false,
          releaseWebviewOnTray: settings.release_webview_on_tray ?? false,
          trayEnabled: settings.tray_enabled ?? true,
        })
        : invoke('set_always_on_top', { enabled: settings.always_on_top ?? false }));
      if (label === 'main') {
        void runStartupTask('autostart', async () => {
          const { enable, disable } = await import('@tauri-apps/plugin-autostart');
          await (settings.auto_start ? enable() : disable());
        });
      }
    });
  }, []);
}
