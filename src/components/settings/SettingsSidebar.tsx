import { Menu, theme } from 'antd';
import { Cloud, Settings, Palette, Globe, Zap, Database, Info, Search, Plug, CloudUpload, Bot, HardDrive, MessageSquare, ArrowLeft, TextCursorInput, Terminal, Cpu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore, useUIStore } from '@/stores';
import type { SettingsSection, SettingsSidebarDensity } from '@/types';

const MENU_ICONS: Record<SettingsSection, React.ReactNode> = {
  providers: <Cloud size={16} />,
  conversationSettings: <MessageSquare size={16} />,
  defaultModel: <Bot size={16} />,
  general: <Settings size={16} />,
  localModels: <Cpu size={16} />,
  display: <Palette size={16} />,
  proxy: <Globe size={16} />,
  shortcuts: <Zap size={16} />,
  data: <Database size={16} />,
  storage: <HardDrive size={16} />,
  about: <Info size={16} />,
  searchProviders: <Search size={16} />,
  mcpServers: <Plug size={16} />,
  backup: <CloudUpload size={16} />,
  selectionToolbar: <TextCursorInput size={16} />,
  acpAgents: <Terminal size={16} />,
};

const SECTION_KEYS: SettingsSection[] = [
  'general',
  'display',
  'providers',
  'conversationSettings',
  'defaultModel',
  'localModels',
  'searchProviders',
  'mcpServers',
  'acpAgents',
  'proxy',
  'shortcuts',
  'selectionToolbar',
  'data',
  'storage',
  'backup',
  'about',
];

const DENSITY_HEIGHT_OFFSETS: Record<SettingsSidebarDensity, number> = {
  compact: -4,
  standard: 0,
  spacious: 8,
};

export function resolveSettingsSidebarItemHeight(
  fontSize: number,
  density: SettingsSidebarDensity,
): number {
  const baseHeight = Math.min(52, Math.max(40, 40 + 2 * (fontSize - 14)));
  return Math.min(56, Math.max(36, baseHeight + DENSITY_HEIGHT_OFFSETS[density]));
}

export function SettingsSidebar() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const fontSize = useSettingsStore((s) => s.settings.font_size);
  const density = useSettingsStore((s) => s.settings.settings_sidebar_density);
  const settingsSection = useUIStore((s) => s.settingsSection);
  const setSettingsSection = useUIStore((s) => s.setSettingsSection);
  const exitSettings = useUIStore((s) => s.exitSettings);
  const itemHeight = resolveSettingsSidebarItemHeight(fontSize, density);

  const items = SECTION_KEYS.map((key) => ({
    key,
    icon: MENU_ICONS[key],
    label: t([`settings.${key}.title`, `settings.${key}`]),
  }));

  return (
    <div className="h-full flex flex-col" data-os-scrollbar style={{ backgroundColor: token.colorBgContainer, overflowY: 'auto' }}>
      {/* Back button */}
      <div
        className="flex items-center gap-2 cursor-pointer"
        style={{
          color: token.colorTextSecondary,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          flexShrink: 0,
          paddingLeft: 26,
          paddingRight: 16,
          paddingTop: 12,
          paddingBottom: 12,
        }}
        onClick={exitSettings}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = token.colorText;
          e.currentTarget.style.backgroundColor = token.colorFillSecondary;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = token.colorTextSecondary;
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <ArrowLeft size={16} />
        <span style={{ fontSize: 14 }}>{t('common.back')}</span>
        <span
          style={{
            fontSize: 11,
            color: token.colorTextQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 4,
            padding: '1px 6px',
            marginLeft: 4,
            lineHeight: '16px',
          }}
        >
          Esc
        </span>
      </div>
      <div className="flex-1 pt-1" style={{ overflowY: 'auto' }}>
        <Menu
          mode="inline"
          selectedKeys={[settingsSection]}
          items={items}
          style={{ borderInlineEnd: 'none' }}
          styles={{ item: { height: itemHeight, lineHeight: `${itemHeight}px` } }}
          onClick={({ key }) => setSettingsSection(key as SettingsSection)}
        />
      </div>
    </div>
  );
}
