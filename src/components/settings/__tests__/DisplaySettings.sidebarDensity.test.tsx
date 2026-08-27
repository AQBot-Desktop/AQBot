import type React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@/types';
import { DisplaySettings } from '../DisplaySettings';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
}));

let settings: Partial<AppSettings> = {};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'settings.groupTheme': '主题',
        'settings.theme': '主题',
        'settings.themeSystem': '跟随系统',
        'settings.themeLight': '浅色',
        'settings.themeDark': '深色',
        'settings.primaryColor': '主题色',
        'settings.groupTitlebarIcons': '顶部导航栏',
        'settings.titlebarIconsHint': '点击图标切换显示/隐藏',
        'settings.titlebarIconsShowAll': '全部显示',
        'settings.titlebarIconVisible': '显示中',
        'settings.titlebarIconHidden': '已隐藏',
        'settings.titlebarIconSettingsLocked': '设置入口始终显示，无法关闭',
        'settings.titlebarIcon.pin': '窗口置顶',
        'settings.titlebarIcon.theme': '主题切换',
        'settings.titlebarIcon.language': '语言切换',
        'settings.titlebarIcon.backup': '快速备份',
        'settings.titlebarIcon.github': 'GitHub',
        'settings.titlebarIcon.update': '检查更新',
        'settings.titlebarIcon.reload': '刷新页面',
        'settings.titlebarIcon.settings': '设置',
        'settings.groupFontRadius': '字体与圆角',
        'settings.fontSize': '界面字号',
        'settings.settingsSidebarDensity': '设置页侧栏密度',
        'settings.settingsSidebarDensityDesc': '项目高度会随界面字号自动调整。',
        'settings.densityCompact': '紧凑',
        'settings.densityStandard': '标准',
        'settings.densitySpacious': '宽松',
        'settings.fontWeight': '界面字重',
        'settings.fontStyle': '字体样式',
        'settings.fontFamily': '界面字体',
        'settings.fontDefault': '系统默认',
        'settings.codeThemeLight': '代码主题（亮色）',
        'settings.codeThemeDark': '代码主题（暗色）',
        'settings.borderRadius': '圆角大小',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('antd', () => ({
  ColorPicker: () => null,
  Divider: () => <hr />,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Segmented: ({
    value,
    onChange,
    options,
    ...props
  }: {
    value?: string;
    onChange?: (value: string) => void;
    options: Array<{ label: React.ReactNode; value: string }>;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
  }) => (
    <div role="radiogroup" {...props}>
      {options.map((option) => (
        <button
          key={option.value}
          aria-checked={value === option.value}
          role="radio"
          type="button"
          onClick={() => onChange?.(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
  Slider: () => null,
  theme: {
    useToken: () => ({
      token: {
        colorTextDescription: '#666666',
        fontSizeSM: 12,
        colorBorderSecondary: '#eeeeee',
        colorFillQuaternary: '#fafafa',
        colorFillSecondary: '#f5f5f5',
        colorPrimary: '#17A93D',
        colorTextQuaternary: '#bbbbbb',
        borderRadius: 6,
      },
    }),
  },
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

vi.mock('@/hooks/useSystemFonts', () => ({
  useSystemFonts: () => [],
}));

vi.mock('@/constants/codeThemes', () => ({
  SHIKI_LIGHT_THEMES: [],
  SHIKI_DARK_THEMES: [],
  formatThemeName: (name: string) => name,
}));

vi.mock('../SettingsGroup', () => ({
  SettingsGroup: ({
    title,
    extra,
    children,
  }: {
    title?: React.ReactNode;
    extra?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      {title ? <header>{title}</header> : null}
      {extra}
      {children}
    </section>
  ),
}));

vi.mock('../SettingsSelect', () => ({
  SettingsSelect: () => null,
}));

vi.mock('../FontPicker', () => ({
  FontPicker: () => null,
}));

describe('DisplaySettings sidebar density', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {
      theme_mode: 'system',
      primary_color: '#17A93D',
      font_size: 14,
      settings_sidebar_density: 'standard',
      font_weight: 400,
      font_family: '',
      code_theme_light: 'github-light',
      code_theme: 'poimandres',
      border_radius: 8,
    };
  });

  it('labels the density control and describes its automatic font-size adjustment', () => {
    render(<DisplaySettings />);

    const densityControl = screen.getByRole('radiogroup', { name: '设置页侧栏密度' });
    expect(densityControl).toHaveAccessibleDescription('项目高度会随界面字号自动调整。');
    expect(within(densityControl).getByRole('radio', { name: '标准' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('persists the spacious density when selected', () => {
    render(<DisplaySettings />);

    fireEvent.click(screen.getByRole('radio', { name: '宽松' }));

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      settings_sidebar_density: 'spacious',
    });
  });

  it('places title bar icons section before font settings and toggles visibility', () => {
    render(<DisplaySettings />);

    const titlebarHeading = screen.getByText('顶部导航栏');
    const fontHeading = screen.getByText('字体与圆角');
    expect(
      titlebarHeading.compareDocumentPosition(fontHeading)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId('titlebar-icon-toggle-backup'));

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      titlebar_icon_visibility: {
        backup: false,
      },
    });

    const settingsToggle = screen.getByTestId('titlebar-icon-toggle-settings');
    expect(settingsToggle).toBeDisabled();
    fireEvent.click(settingsToggle);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('resets all title bar icons to visible', () => {
    settings = {
      ...settings,
      titlebar_icon_visibility: { pin: false, backup: false },
    };
    render(<DisplaySettings />);

    fireEvent.click(screen.getByText('全部显示'));

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      titlebar_icon_visibility: {},
    });
  });
});
