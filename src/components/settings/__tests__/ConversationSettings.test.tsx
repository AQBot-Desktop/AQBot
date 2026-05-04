import type React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@/types';
import { ConversationSettings } from '../ConversationSettings';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
}));

let settings: Partial<AppSettings> = {};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const labels: Record<string, string> = {
        'settings.additionalFeatures': '附加功能',
        'settings.chatMinimap': '对话导航',
        'settings.showImageModelsInModelSelector': '模型选择器中显示绘画模型',
      };
      return labels[key] ?? fallback ?? key;
    },
  }),
}));

vi.mock('antd', () => {
  const Input = () => null;
  Input.TextArea = ({
    value,
    onChange,
    placeholder,
  }: {
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
    placeholder?: string;
  }) => (
    <textarea
      placeholder={placeholder}
      value={value}
      onChange={onChange}
    />
  );

  return {
    Divider: () => <hr />,
    Input,
    Switch: ({
      checked,
      onChange,
    }: {
      checked?: boolean;
      onChange?: (checked: boolean) => void;
    }) => (
      <button
        aria-checked={checked}
        role="switch"
        type="button"
        onClick={() => onChange?.(!checked)}
      />
    ),
    Card: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
    Dropdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    theme: {
      useToken: () => ({
        token: {
          colorBgBase: '#ffffff',
          colorBgContainer: '#ffffff',
          colorBorderSecondary: '#eeeeee',
          colorFillSecondary: '#f5f5f5',
          colorFillTertiary: '#fafafa',
          colorText: '#111111',
          colorTextDescription: '#666666',
          colorTextSecondary: '#444444',
        },
      }),
    },
  };
});

vi.mock('@/stores', () => ({
  useSettingsStore: (selector: (state: {
    settings: Partial<AppSettings>;
    saveSettings: typeof mocks.saveSettings;
  }) => unknown) => selector({
    settings,
    saveSettings: mocks.saveSettings,
  }),
}));

describe('ConversationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {
      bubble_style: 'minimal',
      chat_minimap_enabled: false,
      chat_minimap_style: 'faq',
      default_system_prompt: null,
      multi_model_display_mode: 'tabs',
      render_user_markdown: false,
      show_image_models_in_model_selector: false,
    };
  });

  it('renders the additional features group below chat navigation', () => {
    render(<ConversationSettings />);

    const text = document.body.textContent ?? '';
    expect(text.indexOf('对话导航')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('附加功能')).toBeGreaterThan(text.indexOf('对话导航'));
    expect(screen.getByText('模型选择器中显示绘画模型')).toBeInTheDocument();
  });

  it('saves the image-model selector setting when toggled', () => {
    render(<ConversationSettings />);

    const additionalGroup = screen.getByText('附加功能').parentElement?.parentElement;
    expect(additionalGroup).not.toBeNull();
    const toggle = within(additionalGroup as HTMLElement).getByRole('switch');

    fireEvent.click(toggle);

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      show_image_models_in_model_selector: true,
    });
  });

  it('saves the disabled image-model selector setting when toggled off', () => {
    settings = {
      ...settings,
      show_image_models_in_model_selector: true,
    };

    render(<ConversationSettings />);

    const additionalGroup = screen.getByText('附加功能').parentElement?.parentElement;
    expect(additionalGroup).not.toBeNull();
    const toggle = within(additionalGroup as HTMLElement).getByRole('switch');

    fireEvent.click(toggle);

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      show_image_models_in_model_selector: false,
    });
  });
});
