import { Card, ColorPicker, Divider, Select, Segmented, Slider } from 'antd';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores';

export function DisplaySettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  const rowStyle = { padding: '4px 0' };

  return (
    <div className="p-6 pb-12">
      <Card size="small" title={t('settings.groupTheme')} style={{ marginBottom: 16 }}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.theme')}</span>
          <Segmented
            value={settings.theme_mode}
            onChange={(val) => saveSettings({ theme_mode: val as string })}
            options={[
              { label: t('settings.themeSystem'), value: 'system', icon: <Monitor size={14} /> },
              { label: t('settings.themeLight'), value: 'light', icon: <Sun size={14} /> },
              { label: t('settings.themeDark'), value: 'dark', icon: <Moon size={14} /> },
            ]}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.primaryColor')}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {[
              '#17A93D', '#1677ff', '#1890ff', '#13c2c2', '#2f54eb',
              '#722ed1', '#eb2f96', '#fa541c', '#faad14', '#fadb14',
              '#a0d911', '#000000',
            ].map((color) => (
              <div
                key={color}
                onClick={() => saveSettings({ primary_color: color })}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  backgroundColor: color,
                  cursor: 'pointer',
                  border: settings.primary_color === color
                    ? '2px solid currentColor'
                    : '2px solid transparent',
                  boxShadow: settings.primary_color === color
                    ? `0 0 0 1px ${color}`
                    : 'none',
                  transition: 'all 0.2s',
                }}
              />
            ))}
            <ColorPicker
              value={settings.primary_color}
              onChangeComplete={(color) =>
                saveSettings({ primary_color: color.toHexString() })
              }
              size="small"
            />
          </div>
        </div>
      </Card>
      <Card size="small" title={t('settings.groupFontRadius')} style={{ marginBottom: 16 }}>
        <div style={{ padding: '4px 0' }}>
          <span>{t('settings.fontSize')}</span>
          <Slider
            min={12}
            max={20}
            value={settings.font_size}
            onChange={(val) => saveSettings({ font_size: val })}
            marks={{ 12: '12', 14: '14', 16: '16', 18: '18', 20: '20' }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={{ padding: '4px 0' }}>
          <span>{t('settings.borderRadius')}</span>
          <Slider
            min={0}
            max={20}
            value={settings.border_radius}
            onChange={(val) => saveSettings({ border_radius: val })}
            marks={{ 0: '0', 4: '4', 8: '8', 12: '12', 16: '16', 20: '20' }}
          />
        </div>
      </Card>
      <Card size="small" title={t('settings.groupMessageStyle')}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.bubbleStyle')}</span>
          <Select
            value={settings.bubble_style}
            onChange={(val) => saveSettings({ bubble_style: val })}
            style={{ width: 200 }}
            options={[
              { label: t('settings.bubbleModern'), value: 'modern' },
              { label: t('settings.bubbleCompact'), value: 'compact' },
              { label: t('settings.bubbleMinimal'), value: 'minimal' },
            ]}
          />
        </div>

      </Card>
    </div>
  );
}
