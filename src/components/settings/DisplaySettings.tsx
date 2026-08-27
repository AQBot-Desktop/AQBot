import { ColorPicker, Divider, Segmented, Slider, Tooltip, theme } from 'antd';
import {
  ArrowDownCircle,
  CloudUpload,
  Github,
  Globe,
  Moon,
  Monitor,
  Pin,
  RotateCcw,
  Settings,
  Sun,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import { useSettingsStore } from '@/stores';
import type { SettingsSidebarDensity, TitlebarIconId, TitlebarToggleableIconId } from '@/types';
import { SHIKI_LIGHT_THEMES, SHIKI_DARK_THEMES, formatThemeName } from '@/constants/codeThemes';
import {
  TITLEBAR_ICON_IDS,
  TITLEBAR_ICON_LABEL_KEYS,
  isTitlebarIconVisible,
} from '@/lib/titlebarIcons';
import { normalizeFontStyle } from '@/lib/systemFonts';
import { FontPicker } from './FontPicker';
import { SettingsGroup } from './SettingsGroup';
import { SettingsSelect } from './SettingsSelect';

const TITLEBAR_PREVIEW_ICONS: Record<TitlebarIconId, ReactNode> = {
  pin: <Pin size={14} />,
  theme: <Monitor size={14} />,
  language: <Globe size={14} />,
  backup: <CloudUpload size={14} />,
  github: <Github size={14} />,
  update: <ArrowDownCircle size={14} />,
  reload: <RotateCcw size={14} />,
  settings: <Settings size={14} />,
};

export function DisplaySettings() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  const rowStyle = { padding: '4px 0' };

  const lightThemeOptions = useMemo(
    () => SHIKI_LIGHT_THEMES.map((id) => ({ label: formatThemeName(id), value: id })),
    [],
  );
  const darkThemeOptions = useMemo(
    () => SHIKI_DARK_THEMES.map((id) => ({ label: formatThemeName(id), value: id })),
    [],
  );

  const toggleTitlebarIcon = (id: TitlebarToggleableIconId) => {
    const nextVisible = !isTitlebarIconVisible(settings, id);
    saveSettings({
      titlebar_icon_visibility: {
        ...settings.titlebar_icon_visibility,
        [id]: nextVisible,
      },
    });
  };

  const showAllTitlebarIcons = () => {
    saveSettings({ titlebar_icon_visibility: {} });
  };

  return (
    <div className="p-6 pb-12">
      <SettingsGroup title={t('settings.groupTheme')}>
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
      </SettingsGroup>

      {/* Title bar icons — above font & radius */}
      <SettingsGroup
        title={t('settings.groupTitlebarIcons')}
        extra={
          <button
            type="button"
            onClick={showAllTitlebarIcons}
            style={{
              border: 'none',
              background: 'transparent',
              color: token.colorPrimary,
              cursor: 'pointer',
              fontSize: 12,
              padding: 0,
            }}
          >
            {t('settings.titlebarIconsShowAll')}
          </button>
        }
      >
        <div style={{ color: 'var(--ant-color-text-secondary)', fontSize: 12, marginBottom: 10 }}>
          {t('settings.titlebarIconsHint')}
        </div>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px',
            borderRadius: 999,
            border: `1px solid ${token.colorBorderSecondary}`,
            backgroundColor: token.colorFillQuaternary,
          }}
        >
          {TITLEBAR_ICON_IDS.map((id) => {
            const locked = id === 'settings';
            const visible = locked || isTitlebarIconVisible(settings, id);
            const label = t(TITLEBAR_ICON_LABEL_KEYS[id]);
            const tip = locked
              ? t('settings.titlebarIconSettingsLocked')
              : `${label} · ${visible ? t('settings.titlebarIconVisible') : t('settings.titlebarIconHidden')}`;
            return (
              <Tooltip key={id} title={tip}>
                <button
                  type="button"
                  data-testid={`titlebar-icon-toggle-${id}`}
                  aria-label={label}
                  aria-pressed={visible}
                  disabled={locked}
                  onClick={() => {
                    if (!locked) toggleTitlebarIcon(id);
                  }}
                  style={{
                    width: 28,
                    height: 28,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: token.borderRadius,
                    border: 'none',
                    backgroundColor: 'transparent',
                    color: visible ? token.colorPrimary : token.colorTextQuaternary,
                    cursor: locked ? 'not-allowed' : 'pointer',
                    transition: 'color 0.15s ease, background-color 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    if (locked) return;
                    e.currentTarget.style.backgroundColor = token.colorFillSecondary;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  {TITLEBAR_PREVIEW_ICONS[id]}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.groupFontRadius')}>
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
        <div style={rowStyle} className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <span id="settings-sidebar-density-label">
              {t('settings.settingsSidebarDensity')}
            </span>
            <div
              id="settings-sidebar-density-description"
              style={{ color: token.colorTextDescription, fontSize: token.fontSizeSM, marginTop: 2 }}
            >
              {t('settings.settingsSidebarDensityDesc')}
            </div>
          </div>
          <Segmented
            aria-labelledby="settings-sidebar-density-label"
            aria-describedby="settings-sidebar-density-description"
            value={settings.settings_sidebar_density}
            onChange={(val) =>
              saveSettings({ settings_sidebar_density: val as SettingsSidebarDensity })
            }
            options={[
              { label: t('settings.densityCompact'), value: 'compact' },
              { label: t('settings.densityStandard'), value: 'standard' },
              { label: t('settings.densitySpacious'), value: 'spacious' },
            ]}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.fontFamily')}</span>
          <FontPicker
            value={{
              family: settings.font_family || '',
              weight: settings.font_weight ?? 400,
              style: normalizeFontStyle(settings.font_style),
            }}
            onChange={(next) => saveSettings({
              font_family: next.family,
              font_weight: next.weight,
              font_style: next.style,
            })}
            familyAriaLabel={t('settings.fontFamily')}
            styleAriaLabel={t('settings.fontStyle')}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.codeThemeLight')}</span>
          <SettingsSelect
            searchable
            value={settings.code_theme_light || 'github-light'}
            onChange={(val) => saveSettings({ code_theme_light: val })}
            options={lightThemeOptions}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.codeThemeDark')}</span>
          <SettingsSelect
            searchable
            value={settings.code_theme || 'poimandres'}
            onChange={(val) => saveSettings({ code_theme: val })}
            options={darkThemeOptions}
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
      </SettingsGroup>
    </div>
  );
}
