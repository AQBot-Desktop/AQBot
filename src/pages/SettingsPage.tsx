import { useLayoutEffect, useRef } from 'react';
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
  BackupCenter,
  StorageSpaceManager,
} from '@/components/settings';
import { DefaultModelSettings } from '@/components/settings/DefaultModelSettings';
import { ConversationSettings } from '@/components/settings/ConversationSettings';
import type { SettingsSection } from '@/types';

const SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  providers: ProviderSettings,
  conversationSettings: ConversationSettings,
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
  backup: BackupCenter,
};

export function SettingsPage() {
  const { token } = theme.useToken();
  const settingsSection = useUIStore((s) => s.settingsSection);
  const ContentComponent = SECTION_COMPONENTS[settingsSection];
  const contentScrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const contentScroller = contentScrollRef.current;
    if (!contentScroller) return;

    contentScroller.scrollTop = 0;
    contentScroller.scrollLeft = 0;
  }, [settingsSection]);

  return (
    <div className="flex h-full">
      <div
        className="w-56 shrink-0 h-full"
        style={{ borderRight: '1px solid var(--border-color)', backgroundColor: token.colorBgContainer }}
      >
        <SettingsSidebar />
      </div>
      <div
        ref={contentScrollRef}
        className="min-w-0 flex-1 overflow-y-auto"
        style={{ backgroundColor: token.colorBgElevated }}
      >
        <ContentComponent />
      </div>
    </div>
  );
}
