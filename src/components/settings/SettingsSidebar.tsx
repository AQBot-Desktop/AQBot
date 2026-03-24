import { Menu, Tag, theme } from 'antd';
import { Cloud, Settings, Palette, Globe, Zap, Database, Info, Search, Plug, BookOpen, Lightbulb, CloudUpload, Bot, HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '@/stores';
import type { SettingsSection } from '@/types';

const MENU_ICONS: Record<SettingsSection, React.ReactNode> = {
  providers: <Cloud size={16} />,
  defaultModel: <Bot size={16} />,
  general: <Settings size={16} />,
  display: <Palette size={16} />,
  proxy: <Globe size={16} />,
  shortcuts: <Zap size={16} />,
  data: <Database size={16} />,
  storage: <HardDrive size={16} />,
  about: <Info size={16} />,
  searchProviders: <Search size={16} />,
  mcpServers: <Plug size={16} />,
  knowledge: <BookOpen size={16} />,
  memory: <Lightbulb size={16} />,
  backup: <CloudUpload size={16} />,
};

const SECTION_KEYS: SettingsSection[] = [
  'general',
  'display',
  'providers',
  'defaultModel',
  'searchProviders',
  'mcpServers',
  'knowledge',
  'memory',
  'proxy',
  'shortcuts',
  'data',
  'storage',
  'backup',
  'about',
];

export function SettingsSidebar() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const settingsSection = useUIStore((s) => s.settingsSection);
  const setSettingsSection = useUIStore((s) => s.setSettingsSection);

  const COMING_SOON_SECTIONS: SettingsSection[] = ['knowledge', 'memory'];

  const items = SECTION_KEYS.map((key) => ({
    key,
    icon: MENU_ICONS[key],
    label: (
      <span className="flex items-center gap-1">
        {t([`settings.${key}.title`, `settings.${key}`])}
        {COMING_SOON_SECTIONS.includes(key) && (
          <Tag color="orange" bordered={false} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginLeft: 4 }}>
            {t('common.comingSoon')}
          </Tag>
        )}
      </span>
    ),
    disabled: COMING_SOON_SECTIONS.includes(key),
  }));

  return (
    <div className="h-full pt-4" style={{ backgroundColor: token.colorBgContainer, overflowY: 'auto' }}>
      <Menu
        mode="inline"
        selectedKeys={[settingsSection]}
        items={items}
        style={{ borderInlineEnd: 'none' }}
        onClick={({ key }) => setSettingsSection(key as SettingsSection)}
      />
    </div>
  );
}
