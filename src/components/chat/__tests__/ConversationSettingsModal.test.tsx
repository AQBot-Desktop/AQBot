import type React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSettingsModal } from '../ConversationSettingsModal';

const mocks = vi.hoisted(() => ({
  updateConversation: vi.fn(),
  close: vi.fn(),
  error: vi.fn(),
}));

const conversation = {
  id: 'conv-1',
  title: 'Test conversation',
  provider_id: 'provider-1',
  model_id: 'model-1',
  system_prompt: null,
  temperature: null,
  top_p: null,
  max_tokens: null,
  frequency_penalty: null,
  context_compression: false,
  context_strategy_override: null,
  context_message_limit: null,
  compression_keep_last_n: null,
  multi_model_display_mode_override: null as 'tabs' | 'side-by-side' | 'stacked' | null,
  multi_model_targets: [] as Array<{ providerId: string; modelId: string }>,
  multi_model_continuation_mode: 'selected' as const,
};

const settings = {
  default_context_count: 12,
  default_context_strategy: 'raw_truncate' as const,
  default_compression_keep_last_n: 3,
  multi_model_display_mode: 'side-by-side' as const,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/stores', () => ({
  useConversationStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    conversations: [conversation],
    activeConversationId: conversation.id,
    updateConversation: mocks.updateConversation,
  }),
  useProviderStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ providers: [] }),
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ settings }),
}));

vi.mock('@/lib/modelCapabilities', () => ({ findModelByIds: () => null }));
vi.mock('@/lib/modelParams', () => ({
  resolveModelParamDefaults: () => ({
    temperature: 1,
    topP: 1,
    maxTokens: 4096,
    frequencyPenalty: 0,
  }),
}));
vi.mock('@/components/shared/IconEditor', () => ({ IconEditor: () => null }));
vi.mock('@/components/common/ModelParamSliders', () => ({ ModelParamSliders: () => null }));
vi.mock('../ConversationModelIcon', () => ({ ConversationModelIcon: () => null }));

vi.mock('@/components/settings/SettingsSelect', () => ({
  SettingsSelect: ({
    value,
    onChange,
    options,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    options: Array<{ label: React.ReactNode; value: string }>;
  }) => (
    <select value={value} onChange={(event) => onChange?.(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

vi.mock('antd', () => {
  const Input = ({ value, onChange }: {
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
  }) => <input value={value ?? ''} onChange={onChange} />;
  Input.TextArea = ({ value, onChange }: {
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
  }) => <textarea value={value ?? ''} onChange={onChange} />;

  return {
    App: { useApp: () => ({ message: { error: mocks.error } }) },
    Modal: ({ children, footer, open }: {
      children?: React.ReactNode;
      footer?: React.ReactNode;
      open?: boolean;
    }) => open ? <div>{children}{footer}</div> : null,
    Input,
    InputNumber: ({ value, onChange, min, max, 'aria-label': ariaLabel }: {
      value?: number;
      onChange?: (value: number | null) => void;
      min?: number;
      max?: number;
      'aria-label'?: string;
    }) => (
      <input
        aria-label={ariaLabel}
        type="number"
        min={min}
        max={max}
        value={value ?? ''}
        onChange={(event) => onChange?.(Number(event.target.value))}
      />
    ),
    Button: ({ children, onClick }: {
      children?: React.ReactNode;
      onClick?: () => void;
    }) => <button type="button" onClick={onClick}>{children}</button>,
    Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Card: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
    theme: {
      useToken: () => ({
        token: {
          colorText: '#111',
          colorTextSecondary: '#555',
          colorTextDescription: '#777',
          colorWarning: '#fa0',
        },
      }),
    },
  };
});

describe('ConversationSettingsModal context controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateConversation.mockResolvedValue(undefined);
    conversation.context_compression = false;
    conversation.context_strategy_override = null;
    conversation.context_message_limit = null;
    conversation.compression_keep_last_n = null;
    conversation.multi_model_display_mode_override = null;
    localStorage.clear();
  });

  it('preserves inherited context settings as null when saving unrelated fields', async () => {
    render(<ConversationSettingsModal open onClose={mocks.close} />);

    const selects = screen.getAllByRole('combobox');
    expect(selects).toHaveLength(4);
    expect(selects.map((select) => (select as HTMLSelectElement).value)).toEqual([
      'inherit',
      'inherit',
      'inherit',
      'inherit',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(mocks.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        context_message_limit: null,
        context_strategy_override: null,
        context_compression: false,
        compression_keep_last_n: null,
        multi_model_display_mode_override: null,
      }),
    ));
  });

  it('supports explicit strict, unlimited, and keep-last 1000 settings', async () => {
    render(<ConversationSettingsModal open onClose={mocks.close} />);

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'unlimited' } });
    fireEvent.change(selects[1], { target: { value: 'raw_strict' } });
    fireEvent.change(selects[2], { target: { value: 'custom' } });

    const keepLastInput = screen.getByLabelText('settings.compressionKeepLastN');
    expect(keepLastInput).toHaveAttribute('max', '1000');
    fireEvent.change(keepLastInput, { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(mocks.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        context_message_limit: 50,
        context_strategy_override: 'raw_strict',
        context_compression: false,
        compression_keep_last_n: 1000,
      }),
    ));
  });

  it('saves an explicit multi-model layout override for the conversation', async () => {
    render(<ConversationSettingsModal open onClose={mocks.close} />);

    const selects = screen.getAllByRole('combobox');
    const layoutSelect = selects[3] as HTMLSelectElement;
    expect(layoutSelect.value).toBe('inherit');
    expect(Array.from(layoutSelect.options).map((option) => option.value)).toEqual([
      'inherit',
      'tabs',
      'side-by-side',
      'stacked',
    ]);

    fireEvent.change(layoutSelect, { target: { value: 'stacked' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(mocks.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ multi_model_display_mode_override: 'stacked' }),
    ));
  });
});
