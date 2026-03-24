import { useEffect } from 'react';
import { isTauri } from '@/lib/invoke';
import { useSettingsStore } from '@/stores';
import {
  SHORTCUT_ACTIONS,
  getShortcutBinding,
  isGlobalShortcutAction,
  toTauriAccelerator,
  type ShortcutAction,
} from '@/lib/shortcuts';
import { executeShortcutAction } from '@/lib/shortcutActions';
import type { GlobalShortcutDiagnostic, GlobalShortcutStatus } from '@/stores/settingsStore';

export function useGlobalShortcutManager() {
  const settings = useSettingsStore((s) => s.settings);
  const setGlobalShortcutStatus = useSettingsStore((s) => s.setGlobalShortcutStatus);

  useEffect(() => {
    const diagnostics: GlobalShortcutDiagnostic[] = [];
    const pushDiagnostic = (
      entry: Omit<GlobalShortcutDiagnostic, 'timestamp'>,
    ) => {
      const withTimestamp: GlobalShortcutDiagnostic = {
        timestamp: new Date().toISOString(),
        ...entry,
      };
      diagnostics.push(withTimestamp);
      if (diagnostics.length > 40) {
        diagnostics.splice(0, diagnostics.length - 40);
      }
      if (!settings.shortcut_registration_logs_enabled) return;
      const consolePayload = {
        phase: withTimestamp.phase,
        level: withTimestamp.level,
        action: withTimestamp.action,
        shortcut: withTimestamp.shortcut,
        reason: withTimestamp.reason,
        message: withTimestamp.message,
      };
      if (withTimestamp.level === 'error') {
        console.error('[global-shortcut]', consolePayload);
      } else if (withTimestamp.level === 'warn') {
        console.warn('[global-shortcut]', consolePayload);
      } else {
        console.info('[global-shortcut]', consolePayload);
      }
    };
    const updateStatus = (status: Omit<GlobalShortcutStatus, 'diagnostics'>) => {
      setGlobalShortcutStatus({
        ...status,
        diagnostics: settings.shortcut_registration_logs_enabled ? [...diagnostics] : [],
      });
    };

    if (!isTauri()) {
      pushDiagnostic({
        phase: 'env',
        level: 'warn',
        message: 'Skipping global shortcut registration because current runtime is not Tauri.',
      });
      updateStatus({ enabled: false, registered: [], failed: [] });
      return;
    }
    if (!settings.global_shortcuts_enabled) {
      pushDiagnostic({
        phase: 'env',
        level: 'info',
        message: 'Global shortcuts are disabled by settings.',
      });
      updateStatus({ enabled: false, registered: [], failed: [] });
      void import('@tauri-apps/plugin-global-shortcut')
        .then(async ({ unregisterAll }) => {
          await unregisterAll();
          pushDiagnostic({
            phase: 'cleanup',
            level: 'info',
            message: 'Unregistered all global shortcuts while disabled.',
          });
          updateStatus({ enabled: false, registered: [], failed: [] });
        })
        .catch((error) => {
          pushDiagnostic({
            phase: 'cleanup',
            level: 'warn',
            message: 'Failed to unregister global shortcuts while disabled.',
            reason: String(error),
          });
          updateStatus({ enabled: false, registered: [], failed: [] });
        });
      return;
    }

    let cancelled = false;

    const registerAll = async () => {
      const registered: string[] = [];
      const failed: Array<{ shortcut: string; reason: string }> = [];
      pushDiagnostic({
        phase: 'register',
        level: 'info',
        message: 'Starting global shortcut registration pass.',
      });
      try {
        const { register, unregisterAll, isRegistered } = await import('@tauri-apps/plugin-global-shortcut');
        pushDiagnostic({
          phase: 'register',
          level: 'info',
          message: 'Global shortcut plugin loaded.',
        });
        await unregisterAll();
        pushDiagnostic({
          phase: 'cleanup',
          level: 'info',
          message: 'Cleared previously registered global shortcuts before re-register.',
        });
        if (cancelled) return;

        for (const action of SHORTCUT_ACTIONS) {
          if (!isGlobalShortcutAction(action)) continue;
          const binding = getShortcutBinding(settings, action);
          const accelerator = toTauriAccelerator(binding);
          pushDiagnostic({
            phase: 'register',
            level: 'info',
            action,
            shortcut: accelerator,
            message: 'Attempting to register global shortcut.',
          });
          try {
            await register(accelerator, async (event) => {
              if (event.state !== 'Pressed') return;
              pushDiagnostic({
                phase: 'register',
                level: 'info',
                action,
                shortcut: accelerator,
                message: 'Global shortcut callback fired.',
              });
              console.info('[shortcut-global-hit]', {
                action,
                accelerator,
                eventShortcut: event.shortcut,
                state: event.state,
              });
              await executeShortcutAction(action as ShortcutAction);
            });
            const verifyRegistered = await isRegistered(accelerator);
            if (!verifyRegistered) {
              const reason = 'register returned without error but isRegistered returned false';
              failed.push({ shortcut: accelerator, reason });
              pushDiagnostic({
                phase: 'register',
                level: 'warn',
                action,
                shortcut: accelerator,
                reason,
                message: 'Global shortcut registration verification failed.',
              });
              continue;
            }
            registered.push(accelerator);
            pushDiagnostic({
              phase: 'register',
              level: 'info',
              action,
              shortcut: accelerator,
              message: 'Global shortcut registered successfully.',
            });
          } catch (error) {
            const reason = String(error);
            failed.push({ shortcut: accelerator, reason });
            pushDiagnostic({
              phase: 'register',
              level: 'error',
              action,
              shortcut: accelerator,
              reason,
              message: 'Failed to register global shortcut.',
            });
            console.warn(`Failed to register global shortcut for ${action} (${accelerator}):`, error);
          }
        }
      } catch (error) {
        const reason = String(error);
        failed.push({ shortcut: '*', reason });
        pushDiagnostic({
          phase: 'register',
          level: 'error',
          shortcut: '*',
          reason,
          message: 'Failed to initialize global shortcut plugin.',
        });
        console.warn('Failed to register global shortcuts:', error);
      } finally {
        if (!cancelled) {
          pushDiagnostic({
            phase: 'register',
            level: failed.length > 0 ? 'warn' : 'info',
            message: `Registration pass finished. success=${registered.length}, failed=${failed.length}`,
          });
          updateStatus({
            enabled: true,
            registered,
            failed,
          });
        }
      }
    };

    void registerAll();

    return () => {
      cancelled = true;
      if (settings.global_shortcuts_enabled) {
        void import('@tauri-apps/plugin-global-shortcut')
          .then(async ({ unregisterAll }) => {
            await unregisterAll();
            pushDiagnostic({
              phase: 'cleanup',
              level: 'info',
              message: 'Unregistered all global shortcuts on effect cleanup.',
            });
            updateStatus({ enabled: true, registered: [], failed: [] });
          })
          .catch((error) => {
            pushDiagnostic({
              phase: 'cleanup',
              level: 'warn',
              message: 'Failed to unregister global shortcuts on cleanup.',
              reason: String(error),
            });
            updateStatus({ enabled: true, registered: [], failed: [] });
          });
      }
    };
  }, [settings, setGlobalShortcutStatus]);
}
