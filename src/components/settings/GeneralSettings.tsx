import { Card, Divider, Select, Switch } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores';
import { isTauri, invoke } from '@/lib/invoke';

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
      <Card size="small" title={t('settings.groupLanguage')} style={{ marginBottom: 16 }}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.language')}</span>
          <Select
            value={i18n.language}
            onChange={handleLanguageChange}
            options={[
              { label: '简体中文', value: 'zh-CN' },
              { label: 'English', value: 'en-US' },
            ]}
            style={{ width: 200 }}
          />
        </div>
      </Card>

      {/* Startup */}
      <Card size="small" title={t('settings.groupStartup')} style={{ marginBottom: 16 }}>
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
      </Card>

      {/* Tray & Window */}
      <Card size="small" title={t('settings.groupTray')}>
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
      </Card>
    </div>
  );
}
