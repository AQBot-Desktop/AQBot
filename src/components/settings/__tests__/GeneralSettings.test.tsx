import type React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@/types';
import { GeneralSettings } from '../GeneralSettings';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  invoke: vi.fn(),
  messageWarning: vi.fn(),
}));

let settings: Partial<AppSettings> = {};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: 'zh-CN',
      changeLanguage: vi.fn(),
    },
    t: (key: string) => {
      const labels: Record<string, string> = {
        'settings.groupLanguage': '语言',
        'settings.language': '语言',
        'settings.groupModelCatalog': '模型目录',
        'settings.modelCatalogSetting': '模型元数据来源',
        'settings.modelCatalogSettingHint': '将在下次同步模型时生效',
        'settings.modelCatalogBuiltinOption': '内置（推荐，离线可用）',
        'settings.modelCatalogOnlineOption': '在线（LiteLLM，24 小时缓存）',
        'settings.groupStartup': '启动',
        'settings.autoStart': '开机自启动',
        'settings.showOnStart': '启动时显示窗口',
        'settings.groupTray': '托盘',
        'settings.trayEnabled': '显示系统托盘',
        'settings.trayEnabledDesc': '关闭后完全不显示托盘图标',
        'settings.trayCreateFailed': '无法创建系统托盘',
        'settings.trayIconStyle': '托盘图标样式',
        'settings.trayIconStyleDesc': '仅影响 macOS 菜单栏图标',
        'settings.trayIconStyleColor': '彩色',
        'settings.trayIconStyleMonochrome': '单色',
        'settings.trayIconUpdateFailed': '无法更新托盘图标',
        'settings.minimizeToTray': '关闭时最小化到托盘',
        'settings.releaseWebviewOnTray': '释放界面进程',
        'settings.confirmOnQuit': '退出应用时确认',
        'desktop.alwaysOnTop': '窗口置顶',
        'desktop.startMinimized': '启动时最小化',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('antd', () => {
  const Input = () => null;
  Input.TextArea = () => null;

  return {
    App: {
      useApp: () => ({
        message: { warning: mocks.messageWarning, success: vi.fn(), error: vi.fn() },
      }),
    },
    Card: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
    Divider: () => <hr />,
    Dropdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Input,
    Switch: ({
      checked,
      disabled,
      onChange,
    }: {
      checked?: boolean;
      disabled?: boolean;
      onChange?: (checked: boolean) => void;
    }) => (
      <button
        aria-checked={checked}
        disabled={disabled}
        role="switch"
        type="button"
        onClick={() => onChange?.(!checked)}
      />
    ),
    theme: {
      useToken: () => ({
        token: {
          colorBgBase: '#ffffff',
          colorBgContainer: '#ffffff',
          colorBorderSecondary: '#eeeeee',
          colorFillSecondary: '#f5f5f5',
          colorFillTertiary: '#fafafa',
          colorText: '#111111',
          colorTextSecondary: '#444444',
        },
      }),
    },
  };
});

vi.mock('@/lib/constants', () => ({
  LANG_OPTIONS: [{ key: 'zh-CN', label: '简体中文', icon: '中' }],
}));

vi.mock('@/lib/invoke', () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
}));

vi.mock('@/stores', () => ({
  useSettingsStore: (selector: (state: {
    settings: Partial<AppSettings>;
    saveSettings: typeof mocks.saveSettings;
  }) => unknown) => selector({
    settings,
    saveSettings: mocks.saveSettings,
  }),
}));

vi.mock('../SettingsSelect', () => ({
  SettingsSelect: ({
    value,
    onChange,
    options,
    disabled,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    options: Array<{ label: React.ReactNode; value: string }>;
    disabled?: boolean;
  }) => (
    <select
      aria-label={options.map((option) => option.value).join('-')}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {typeof option.label === 'string' ? option.label : option.value}
        </option>
      ))}
    </select>
  ),
}));

function releaseWebviewSwitch() {
  const row = screen.getByText('释放界面进程').parentElement;
  expect(row).not.toBeNull();
  return within(row as HTMLElement).getByRole('switch');
}

function trayEnabledSwitch() {
  const row = screen.getByText('显示系统托盘').parentElement?.parentElement;
  expect(row).not.toBeNull();
  return within(row as HTMLElement).getByRole('switch');
}

function minimizeToTraySwitch() {
  const row = screen.getByText('关闭时最小化到托盘').parentElement;
  expect(row).not.toBeNull();
  return within(row as HTMLElement).getByRole('switch');
}

function trayIconStyleSelect() {
  return screen.getByRole('combobox', { name: 'color-monochrome' });
}

describe('GeneralSettings', () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    platformSpy = vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    mocks.invoke.mockResolvedValue(undefined);
    mocks.saveSettings.mockResolvedValue([]);
    settings = {
      auto_start: false,
      show_on_start: true,
      minimize_to_tray: true,
      tray_enabled: true,
      tray_icon_style: 'color',
      always_on_top: false,
      start_minimized: false,
      release_webview_on_tray: false,
      confirm_on_quit: true,
      model_catalog_source: 'builtin',
    };
  });

  afterEach(() => {
    platformSpy.mockRestore();
  });

  it('renders the release-webview setting disabled by default state false', () => {
    render(<GeneralSettings />);

    const toggle = releaseWebviewSwitch();

    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('saves release-webview setting and syncs native state when toggled', () => {
    render(<GeneralSettings />);

    fireEvent.click(releaseWebviewSwitch());

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      release_webview_on_tray: true,
    });
    expect(mocks.invoke).toHaveBeenCalledWith('set_release_webview_on_tray', {
      enabled: true,
    });
  });

  it('defaults quit confirmation to on and saves it when disabled', () => {
    render(<GeneralSettings />);

    const row = screen.getByText('退出应用时确认').parentElement;
    expect(row).not.toBeNull();
    const toggle = within(row as HTMLElement).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);

    expect(mocks.saveSettings).toHaveBeenCalledWith({ confirm_on_quit: false });
  });

  it('disables release-webview setting when close-to-tray is disabled', () => {
    settings = {
      ...settings,
      minimize_to_tray: false,
      release_webview_on_tray: true,
    };

    render(<GeneralSettings />);

    const toggle = releaseWebviewSwitch();
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('defaults to the built-in catalog and saves the online preference', () => {
    render(<GeneralSettings />);

    const select = screen.getByRole('combobox', { name: 'builtin-online' });
    expect(select).toHaveValue('builtin');

    fireEvent.change(select, { target: { value: 'online' } });

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      model_catalog_source: 'online',
    });
  });

  it('disables tray-dependent settings when the tray is hidden', () => {
    settings = {
      ...settings,
      tray_enabled: false,
      minimize_to_tray: true,
      release_webview_on_tray: true,
    };

    render(<GeneralSettings />);

    expect(minimizeToTraySwitch()).toBeDisabled();
    expect(releaseWebviewSwitch()).toBeDisabled();
    fireEvent.click(trayEnabledSwitch());
    expect(mocks.saveSettings).toHaveBeenCalledWith({ tray_enabled: true });
  });

  it('shows the macOS tray icon style and saves monochrome selection', () => {
    render(<GeneralSettings />);

    const select = trayIconStyleSelect();
    expect(select).toHaveValue('color');

    fireEvent.change(select, { target: { value: 'monochrome' } });

    expect(mocks.saveSettings).toHaveBeenCalledWith({ tray_icon_style: 'monochrome' });
  });

  it('hides the tray icon style outside macOS', () => {
    platformSpy.mockReturnValue('Win32');

    render(<GeneralSettings />);

    expect(screen.queryByText('托盘图标样式')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'color-monochrome' })).not.toBeInTheDocument();
  });

  it('disables the tray icon style while the tray is hidden', () => {
    settings = { ...settings, tray_enabled: false, tray_icon_style: 'monochrome' };

    render(<GeneralSettings />);

    expect(trayIconStyleSelect()).toBeDisabled();
    expect(trayIconStyleSelect()).toHaveValue('monochrome');
  });

  it('warns when the native tray icon cannot be updated', async () => {
    mocks.saveSettings.mockResolvedValueOnce(['tray_icon_update_failed']);
    render(<GeneralSettings />);

    fireEvent.change(trayIconStyleSelect(), { target: { value: 'monochrome' } });

    await waitFor(() => {
      expect(mocks.messageWarning).toHaveBeenCalledWith('无法更新托盘图标');
    });
  });
});
