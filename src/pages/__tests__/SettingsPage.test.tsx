import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores';
import { SettingsPage } from '../SettingsPage';

vi.mock('antd', () => ({
  theme: {
    useToken: () => ({
      token: {
        colorBgContainer: '#ffffff',
        colorBgElevated: '#f8f8f8',
      },
    }),
  },
}));

vi.mock('@/components/settings', () => ({
  SettingsSidebar: () => <nav>settings-sidebar</nav>,
  ProviderSettings: () => <div>providers-content</div>,
  GeneralSettings: () => <div>general-content</div>,
  DisplaySettings: () => <div>display-content</div>,
  ProxySettings: () => <div>proxy-content</div>,
  ShortcutSettings: () => <div>shortcuts-content</div>,
  DataManager: () => <div>data-content</div>,
  AboutPage: () => <div>about-content</div>,
  SearchProviderSettings: () => <div>search-providers-content</div>,
  McpServerSettings: () => <div>mcp-servers-content</div>,
  BackupCenter: () => <div>backup-content</div>,
  StorageSpaceManager: () => <div>storage-content</div>,
}));

vi.mock('@/components/settings/DefaultModelSettings', () => ({
  DefaultModelSettings: () => <div>default-model-content</div>,
}));

vi.mock('@/components/settings/ConversationSettings', () => ({
  ConversationSettings: () => <div>conversation-settings-content</div>,
}));

describe('SettingsPage', () => {
  beforeEach(() => {
    act(() => {
      useUIStore.setState({
        activePage: 'settings',
        previousPage: 'chat',
        settingsSection: 'general',
        selectedProviderId: null,
      });
    });
  });

  it('resets the content scroll position when switching settings sections', () => {
    render(<SettingsPage />);

    const contentScroller = screen.getByText('general-content').parentElement as HTMLElement;
    contentScroller.scrollTop = 480;

    act(() => {
      useUIStore.getState().setSettingsSection('display');
    });

    expect(screen.getByText('display-content')).toBeInTheDocument();
    expect(contentScroller.scrollTop).toBe(0);
  });
});
