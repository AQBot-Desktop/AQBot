import { Button, Card, Divider, Input, Space, Switch, Tooltip } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useSettingsStore } from '@/stores';
import {
  SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_DESCRIPTORS,
  SHORTCUT_SETTING_KEYS,
  detectShortcutConflicts,
  formatShortcutForDisplay,
  getShortcutBindingByKey,
  normalizeShortcutFromKeyboardEvent,
  toTauriAccelerator,
  type ShortcutAction,
  type ShortcutSettingKey,
} from '@/lib/shortcuts';

type ShortcutSettingsUpdate = Partial<Record<ShortcutSettingKey | 'global_shortcut', string>>;

export function ShortcutSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const globalShortcutStatus = useSettingsStore((s) => s.globalShortcutStatus);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);
  const [draftBindings, setDraftBindings] = useState<Partial<Record<ShortcutAction, string>>>({});

  const rows = useMemo(() => SHORTCUT_DESCRIPTORS, []);

  const effectiveBindings = useMemo(() => {
    const result: Partial<Record<ShortcutAction, string>> = {};
    for (const action of SHORTCUT_ACTIONS) {
      result[action] = draftBindings[action] || getShortcutBindingByKey(settings, SHORTCUT_SETTING_KEYS[action]);
    }
    return result;
  }, [draftBindings, settings]);

  const conflictMap = useMemo(
    () => detectShortcutConflicts(effectiveBindings),
    [effectiveBindings],
  );
  const failedGlobalShortcutReasonMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of globalShortcutStatus.failed) {
      map.set(item.shortcut, item.reason);
    }
    return map;
  }, [globalShortcutStatus.failed]);

  const valueForAction = useCallback((action: ShortcutAction): string => {
    const draft = draftBindings[action];
    if (draft) return draft;
    return getShortcutBindingByKey(settings, SHORTCUT_SETTING_KEYS[action]);
  }, [draftBindings, settings]);

  const persistBinding = useCallback(async (action: ShortcutAction, binding: string) => {
    const key = SHORTCUT_SETTING_KEYS[action];
    const update: ShortcutSettingsUpdate = {
      [key]: binding,
    };
    if (action === 'toggleCurrentWindow') {
      update.global_shortcut = binding;
    }
    await saveSettings(update);
  }, [saveSettings, settings]);

  const startRecording = useCallback((action: ShortcutAction) => {
    setRecordingAction(action);
    setDraftBindings((prev) => ({ ...prev, [action]: '' }));
  }, []);

  const resetSingleShortcut = useCallback(async (action: ShortcutAction) => {
    const key = SHORTCUT_SETTING_KEYS[action];
    const value = DEFAULT_SHORTCUT_BINDINGS[action];
    const update: ShortcutSettingsUpdate = { [key]: value };
    if (action === 'toggleCurrentWindow') {
      update.global_shortcut = value;
    }
    setDraftBindings((prev) => ({ ...prev, [action]: '' }));
    setRecordingAction((prev) => (prev === action ? null : prev));
    await saveSettings(update);
  }, [saveSettings, settings]);

  const onCaptureKeyDown = useCallback(
    async (action: ShortcutAction, e: React.KeyboardEvent) => {
      if (recordingAction !== action) return;
      e.preventDefault();
      e.stopPropagation();
      const normalized = normalizeShortcutFromKeyboardEvent(e.nativeEvent);
      if (!normalized) return;
      setDraftBindings((prev) => ({ ...prev, [action]: normalized }));
      setRecordingAction(null);
      await persistBinding(action, normalized);
    },
    [persistBinding, recordingAction],
  );

  const handleResetDefaults = useCallback(async () => {
    const update: ShortcutSettingsUpdate = {};
    for (const action of SHORTCUT_ACTIONS) {
      const key = SHORTCUT_SETTING_KEYS[action];
      update[key] = DEFAULT_SHORTCUT_BINDINGS[action];
    }
    update.global_shortcut = DEFAULT_SHORTCUT_BINDINGS.toggleCurrentWindow;
    setDraftBindings({});
    setRecordingAction(null);
    await saveSettings(update);
  }, [saveSettings, settings]);

  return (
    <div className="p-6 pb-12">
      <Card size="small" title={t('settings.groupShortcuts')} style={{ marginBottom: 16 }}>
        <div style={{ padding: '4px 0' }} className="flex items-center justify-between">
          <span>{t('settings.enableGlobalShortcuts')}</span>
          <Switch
            checked={settings.global_shortcuts_enabled ?? false}
            onChange={(checked) => {
              void saveSettings({ global_shortcuts_enabled: checked });
            }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={{ padding: '4px 0' }} className="flex items-center justify-between">
          <span>{t('settings.enableShortcutRegistrationLogs')}</span>
          <Switch
            checked={settings.shortcut_registration_logs_enabled ?? false}
            onChange={(checked) => {
              void saveSettings({ shortcut_registration_logs_enabled: checked });
            }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={{ padding: '4px 0' }} className="flex items-center justify-between">
          <span>{t('settings.enableShortcutTriggerToast')}</span>
          <Switch
            checked={settings.shortcut_trigger_toast_enabled ?? false}
            onChange={(checked) => {
              void saveSettings({ shortcut_trigger_toast_enabled: checked });
            }}
          />
        </div>
        {settings.global_shortcuts_enabled && globalShortcutStatus.failed.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12, color: '#d32029' }}>
            {t('settings.globalShortcutRegisterFailedList', {
              shortcuts: globalShortcutStatus.failed.map((item) => item.shortcut).join(' / '),
            })}
          </div>
        )}
        {settings.global_shortcuts_enabled
          && settings.shortcut_registration_logs_enabled
          && globalShortcutStatus.diagnostics.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 12 }}>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>
              {t('settings.globalShortcutDiagnosticsTitle')}
            </div>
            <div
              style={{
                maxHeight: 180,
                overflowY: 'auto',
                border: '1px solid var(--border-color)',
                borderRadius: 6,
                padding: '6px 8px',
                userSelect: 'text',
                WebkitUserSelect: 'text',
              }}
            >
              {globalShortcutStatus.diagnostics.map((item) => (
                <div
                  key={`${item.timestamp}-${item.phase}-${item.message}-${item.shortcut ?? ''}-${item.action ?? ''}`}
                  style={{
                    marginBottom: 6,
                    color: item.level === 'error' ? '#d32029' : item.level === 'warn' ? '#d89614' : 'inherit',
                    lineHeight: 1.4,
                    userSelect: 'text',
                    WebkitUserSelect: 'text',
                  }}
                >
                  <span style={{ opacity: 0.7 }}>
                    [{new Date(item.timestamp).toLocaleTimeString()}] [{item.phase}] [{item.level}]
                  </span>
                  {' '}
                  {item.message}
                  {item.action ? ` (${item.action})` : ''}
                  {item.shortcut ? ` [${item.shortcut}]` : ''}
                  {item.reason ? ` - ${item.reason}` : ''}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card
        size="small"
        title={t('settings.shortcutListTitle')}
        extra={(
          <Tooltip title={t('settings.resetShortcutDefaults')}>
            <Button
              type="text"
              size="small"
              icon={<RotateCcw size={14} />}
              onClick={() => { void handleResetDefaults(); }}
            />
          </Tooltip>
        )}
      >
        <div style={{ width: '100%' }}>
          {rows.map((descriptor, index) => {
            const action = descriptor.action;
            const binding = valueForAction(action);
            const accelerator = toTauriAccelerator(binding);
            const failedReason = settings.global_shortcuts_enabled && descriptor.supportsGlobal
              ? failedGlobalShortcutReasonMap.get(accelerator) ?? failedGlobalShortcutReasonMap.get('*')
              : undefined;
            const displayValue = recordingAction === action
              ? t('settings.pressShortcut')
              : formatShortcutForDisplay(binding);
            return (
              <div key={action}>
                {index > 0 && <Divider style={{ margin: '4px 0' }} />}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <span>{t(descriptor.labelKey)}</span>
                    {descriptor.supportsGlobal ? (
                      <span style={{ fontSize: 12, opacity: 0.72 }}>
                        {t('settings.shortcutGlobalAndLocal')}
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, opacity: 0.72 }}>
                        {t('settings.shortcutLocalOnly')}
                      </span>
                    )}
                  </div>
                  <Space>
                    {failedReason && (
                      <Tooltip title={t('settings.shortcutGlobalRegisterFailedTip', { reason: failedReason })}>
                        <AlertTriangle size={16} color="#d89614" />
                      </Tooltip>
                    )}
                    <Input
                      readOnly
                      autoFocus={recordingAction === action}
                      value={displayValue}
                      status={conflictMap[action]?.length ? 'error' : undefined}
                      onKeyDown={(event) => {
                        void onCaptureKeyDown(action, event);
                      }}
                      style={{ width: 260 }}
                    />
                    <Button
                      type={recordingAction === action ? 'primary' : 'default'}
                      onClick={() => startRecording(action)}
                    >
                      {t('settings.recordShortcut')}
                    </Button>
                    <Tooltip title={t('settings.resetShortcutSingle')}>
                      <Button
                        type="text"
                        size="small"
                        icon={<RotateCcw size={14} />}
                        onClick={() => { void resetSingleShortcut(action); }}
                      />
                    </Tooltip>
                  </Space>
                </div>
                {conflictMap[action]?.length ? (
                  <div style={{ marginTop: -6, marginBottom: 8, fontSize: 12, color: '#d32029' }}>
                    {t('settings.shortcutConflictWith', {
                      targets: conflictMap[action]
                        ?.map((item) => t(rows.find((row) => row.action === item)?.labelKey ?? ''))
                        .join(' / '),
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
          {Object.keys(conflictMap).length > 0 ? (
            <div style={{ fontSize: 12, color: '#d32029', marginTop: 4 }}>
              {t('settings.shortcutConflictHint')}
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
