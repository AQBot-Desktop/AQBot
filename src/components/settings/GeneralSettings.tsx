import { Divider, Switch } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores';
import { isTauri, invoke } from '@/lib/invoke';
import { LANG_OPTIONS } from '@/lib/constants';
import type { ModelCatalogSourcePreference } from '@/types';
import { SettingsGroup } from './SettingsGroup';
import { SettingsSelect } from './SettingsSelect';

export function GeneralSettings() {
  const { t, i18n } = useTranslation();
  const inTauri = isTauri();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  const handleLanguageChange = (language: string) => {
    i18n.changeLanguage(language);
    saveSettings({ language });
  };

  const rowStyle = { padding: '4px 0' };

  return (
    <div className="p-6 pb-12">
      {/* Language */}
      <SettingsGroup title={t('settings.groupLanguage')}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.language')}</span>
          <SettingsSelect
            value={i18n.language}
            onChange={handleLanguageChange}
            options={LANG_OPTIONS.map((opt) => ({
              label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{opt.icon} {opt.label}</span>,
              value: opt.key,
            }))}
          />
        </div>
      </SettingsGroup>

      {/* Model catalog */}
      <SettingsGroup title={t('settings.groupModelCatalog')}>
        <div style={rowStyle} className="flex items-center justify-between gap-4">
          <div>
            <div>{t('settings.modelCatalogSetting')}</div>
            <div style={{ color: 'var(--ant-color-text-secondary)', fontSize: 12 }}>
              {t('settings.modelCatalogSettingHint')}
            </div>
          </div>
          <SettingsSelect
            value={settings.model_catalog_source ?? 'builtin'}
            onChange={(source) => saveSettings({
              model_catalog_source: source as ModelCatalogSourcePreference,
            })}
            options={[
              {
                label: t('settings.modelCatalogBuiltinOption'),
                value: 'builtin',
              },
              {
                label: t('settings.modelCatalogOnlineOption'),
                value: 'online',
              },
            ]}
            style={{ flexShrink: 0 }}
          />
        </div>
      </SettingsGroup>

      {/* Startup */}
      <SettingsGroup title={t('settings.groupStartup')}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.autoStart')}</span>
          <Switch
            checked={settings.auto_start}
            onChange={async (checked) => {
              saveSettings({ auto_start: checked });
              if (inTauri) {
                try {
                  if (checked) {
                    const { enable } = await import('@tauri-apps/plugin-autostart');
                    await enable();
                  } else {
                    const { disable } = await import('@tauri-apps/plugin-autostart');
                    await disable();
                  }
                } catch (e) {
                  console.warn('Autostart toggle failed:', e);
                }
              }
            }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.showOnStart')}</span>
          <Switch
            checked={settings.show_on_start}
            onChange={(checked) => saveSettings({ show_on_start: checked })}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('desktop.alwaysOnTop')}</span>
          <Switch
            checked={settings.always_on_top ?? false}
            onChange={(checked) => {
              saveSettings({ always_on_top: checked });
              if (inTauri) {
                invoke('set_always_on_top', { enabled: checked }).catch(() => {});
              }
            }}
            disabled={!inTauri}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('desktop.startMinimized')}</span>
          <Switch
            checked={settings.start_minimized ?? false}
            onChange={(checked) => saveSettings({ start_minimized: checked })}
            disabled={!inTauri}
          />
        </div>
      </SettingsGroup>

      {/* Tray & Window */}
      <SettingsGroup title={t('settings.groupTray')}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.minimizeToTray')}</span>
          <Switch
            checked={settings.minimize_to_tray}
            onChange={(checked) => {
              saveSettings({ minimize_to_tray: checked });
              if (inTauri) {
                invoke('set_close_to_tray', { enabled: checked }).catch(() => {});
              }
            }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.releaseWebviewOnTray')}</span>
          <Switch
            checked={settings.minimize_to_tray ? (settings.release_webview_on_tray ?? false) : false}
            disabled={!inTauri || !settings.minimize_to_tray}
            onChange={(checked) => {
              saveSettings({ release_webview_on_tray: checked });
              if (inTauri) {
                invoke('set_release_webview_on_tray', { enabled: checked }).catch(() => {});
              }
            }}
          />
        </div>
      </SettingsGroup>
    </div>
  );
}
