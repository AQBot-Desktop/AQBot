import { theme } from 'antd';
import { useUIStore } from '@/stores';
import {
  SettingsSidebar,
  ProviderSettings,
  GeneralSettings,
  DisplaySettings,
  ProxySettings,
  ShortcutSettings,
  DataManager,
  AboutPage,
  SearchProviderSettings,
  McpServerSettings,
  KnowledgeSettings,
  MemorySettings,
  BackupCenter,
  StorageSpaceManager,
} from '@/components/settings';
import { DefaultModelSettings } from '@/components/settings/DefaultModelSettings';
import type { SettingsSection } from '@/types';

const SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  providers: ProviderSettings,
  defaultModel: DefaultModelSettings,
  general: GeneralSettings,
  display: DisplaySettings,
  proxy: ProxySettings,
  shortcuts: ShortcutSettings,
  data: DataManager,
  storage: StorageSpaceManager,
  about: AboutPage,
  searchProviders: SearchProviderSettings,
  mcpServers: McpServerSettings,
  knowledge: KnowledgeSettings,
  memory: MemorySettings,
  backup: BackupCenter,
};

export function SettingsPage() {
  const { token } = theme.useToken();
  const settingsSection = useUIStore((s) => s.settingsSection);
  const ContentComponent = SECTION_COMPONENTS[settingsSection];

  return (
    <div className="flex h-full">
      <div
        className="w-56 shrink-0 h-full"
        style={{ borderRight: '1px solid var(--border-color)', backgroundColor: token.colorBgContainer }}
      >
        <SettingsSidebar />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto" style={{ backgroundColor: token.colorBgElevated }}>
        <ContentComponent />
      </div>
    </div>
  );
}
