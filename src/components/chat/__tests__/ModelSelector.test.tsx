import type React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, ProviderConfig } from '@/types';
import { ModelSelector } from '../ModelSelector';

const mocks = vi.hoisted(() => ({
  updateConversation: vi.fn(),
  saveSettings: vi.fn(),
  setActivePage: vi.fn(),
  setSettingsSection: vi.fn(),
  setSelectedProviderId: vi.fn(),
}));

let providers: ProviderConfig[] = [];
let conversations: Conversation[] = [];
let settings: Record<string, unknown> = {};

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'OpenAI Compatible',
    provider_type: 'openai',
    api_host: 'https://api.example.com',
    api_path: '/v1/chat/completions',
    aws_region: null,
    enabled: true,
    models: [],
    keys: [],
    proxy_config: null,
    custom_headers: null,
    icon: null,
    builtin_id: null,
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'Test',
    model_id: 'gpt-5.4',
    provider_id: 'provider-1',
    system_prompt: null,
    temperature: null,
    max_tokens: null,
    top_p: null,
    frequency_penalty: null,
    search_enabled: false,
    search_provider_id: null,
    thinking_budget: null,
    thinking_level: null,
    enabled_mcp_server_ids: [],
    enabled_knowledge_base_ids: [],
    enabled_memory_namespace_ids: [],
    multi_model_display_mode_override: null,
    multi_model_targets: [],
    multi_model_continuation_mode: 'selected',
    is_pinned: false,
    tab_pin_order: null,
    is_archived: false,
    context_compression: false,
    context_strategy_override: null,
    context_message_limit: null,
    compression_keep_last_n: null,
    category_id: null,
    parent_conversation_id: null,
    mode: 'chat',
    message_count: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
    sort_order: overrides.sort_order ?? 0,
  };
}

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => <span data-testid="model-icon" />,
}));

vi.mock('../ConversationModelIcon', () => ({
  ConversationModelIcon: ({ model, size }: { model: string; size: number }) => (
    <span data-testid="conversation-model-icon" data-model={model} data-size={size} />
  ),
}));

vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <span data-testid="provider-icon" />,
  SmartModelIcon: ({ modelId }: { modelId: string }) => (
    <span data-testid="model-icon">{modelId}</span>
  ),
}));

vi.mock('@/lib/shortcuts', () => ({
  getShortcutBinding: () => null,
  formatShortcutForDisplay: () => '',
}));

vi.mock('@/lib/modelCapabilities', () => ({
  getVisibleModelCapabilities: (model: { capabilities: string[] }) => model.capabilities,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => React.Key }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 40,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('antd', () => ({
  Space: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Typography: { Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span> },
  Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Modal: ({ open, children, footer, title }: { open?: boolean; children?: React.ReactNode; footer?: React.ReactNode; title?: React.ReactNode }) => (
    open ? <div>{title}{children}{footer}</div> : null
  ),
  Input: ({ prefix, placeholder, value, onChange, onKeyDown }: {
    prefix?: React.ReactNode;
    placeholder?: string;
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  }) => (
    <label>
      {prefix}
      <input placeholder={placeholder} value={value} onChange={onChange} onKeyDown={onKeyDown} />
    </label>
  ),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Button: ({ children, onClick, disabled }: { children?: React.ReactNode; onClick?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onClick}>{children}</button>
  ),
  Checkbox: ({ checked }: { checked?: boolean }) => <input type="checkbox" readOnly checked={checked} />,
  theme: {
    useToken: () => ({
      token: {
        colorPrimary: '#1677ff',
        colorPrimaryBg: '#e6f4ff',
        colorFillSecondary: '#f5f5f5',
        colorFillTertiary: '#fafafa',
        colorTextSecondary: '#666',
        colorTextQuaternary: '#999',
        colorBorderSecondary: '#eee',
      },
    }),
  },
}));

vi.mock('@/stores', () => ({
  useProviderStore: (selector?: (state: { providers: ProviderConfig[] }) => unknown) => {
    const state = { providers };
    return selector ? selector(state) : state;
  },
  useConversationStore: (selector?: (state: { activeConversationId: string; conversations: Conversation[]; updateConversation: typeof mocks.updateConversation }) => unknown) => {
    const state = {
      activeConversationId: 'conv-1',
      conversations,
      updateConversation: mocks.updateConversation,
    };
    return selector ? selector(state) : state;
  },
  useSettingsStore: (selector: (state: { settings: Record<string, unknown>; saveSettings: typeof mocks.saveSettings }) => unknown) =>
    selector({
      settings,
      saveSettings: mocks.saveSettings,
    }),
  useUIStore: (selector: (state: {
    setActivePage: typeof mocks.setActivePage;
    setSettingsSection: typeof mocks.setSettingsSection;
    setSelectedProviderId: typeof mocks.setSelectedProviderId;
  }) => unknown) =>
    selector({
      setActivePage: mocks.setActivePage,
      setSettingsSection: mocks.setSettingsSection,
      setSelectedProviderId: mocks.setSelectedProviderId,
    }),
}));

describe('ModelSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    providers = [
      makeProvider({
        models: [
          {
            provider_id: 'provider-1',
            model_id: 'gpt-5.4',
            name: 'GPT 5.4',
            group_name: null,
            model_type: 'Chat',
            capabilities: ['TextChat'],
            context_window: 128000,
            enabled: true,
            param_overrides: null,
          },
          {
            provider_id: 'provider-1',
            model_id: 'gpt-image-2',
            name: 'GPT Image 2',
            group_name: null,
            model_type: 'Image',
            capabilities: [],
            context_window: null,
            enabled: true,
            param_overrides: null,
          },
          {
            provider_id: 'provider-1',
            model_id: 'text-embedding-3-large',
            name: 'Text Embedding 3 Large',
            group_name: null,
            model_type: 'Embedding',
            capabilities: [],
            context_window: null,
            enabled: true,
            param_overrides: null,
          },
          {
            provider_id: 'provider-1',
            model_id: 'jina-reranker-v3',
            name: 'Jina Reranker v3',
            group_name: null,
            model_type: 'Rerank',
            capabilities: [],
            context_window: null,
            enabled: true,
            param_overrides: null,
          },
        ],
      }),
    ];
    conversations = [makeConversation()];
    settings = {
      default_provider_id: null,
      default_model_id: null,
      show_image_models_in_model_selector: false,
    };
  });

  it('shows only enabled chat models in the conversation model selector', () => {
    render(<ModelSelector open onOpenChange={vi.fn()} />);

    expect(screen.getAllByText('GPT 5.4').length).toBeGreaterThan(0);
    expect(screen.queryByText('GPT Image 2')).not.toBeInTheDocument();
    expect(screen.queryByText('Text Embedding 3 Large')).not.toBeInTheDocument();
    expect(screen.queryByText('Jina Reranker v3')).not.toBeInTheDocument();
  });

  it('does not show pinned non-chat models', () => {
    localStorage.setItem('aqbot_pinned_models', JSON.stringify(['provider-1::gpt-image-2']));

    render(
      <ModelSelector
        open
        onOpenChange={vi.fn()}
        excludeModelKeys={['provider-1::gpt-5.4']}
      />,
    );

    expect(screen.queryByText('chat.pinnedModels')).not.toBeInTheDocument();
    expect(screen.queryByText('GPT Image 2')).not.toBeInTheDocument();
  });

  it('shows enabled image models when the setting is enabled', () => {
    settings = {
      ...settings,
      show_image_models_in_model_selector: true,
    };

    render(<ModelSelector open onOpenChange={vi.fn()} />);

    expect(screen.getAllByText('GPT 5.4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('GPT Image 2').length).toBeGreaterThan(0);
    expect(screen.queryByText('Text Embedding 3 Large')).not.toBeInTheDocument();
    expect(screen.queryByText('Jina Reranker v3')).not.toBeInTheDocument();
  });

  it('shows pinned image models when the setting is enabled', () => {
    settings = {
      ...settings,
      show_image_models_in_model_selector: true,
    };
    localStorage.setItem('aqbot_pinned_models', JSON.stringify(['provider-1::gpt-image-2']));

    render(
      <ModelSelector
        open
        onOpenChange={vi.fn()}
        excludeModelKeys={['provider-1::gpt-5.4']}
      />,
    );

    expect(screen.getByText('chat.pinnedModels')).toBeInTheDocument();
    expect(screen.getAllByText('GPT Image 2').length).toBeGreaterThan(0);
  });

  it('uses the centered conversation model fallback in the current model trigger', () => {
    conversations = [makeConversation({ model_id: 'unknown-model', provider_id: 'missing-provider' })];

    render(<ModelSelector />);

    const icon = screen.getByTestId('conversation-model-icon');
    expect(icon).toHaveAttribute('data-model', 'unknown-model');
    expect(icon).toHaveAttribute('data-size', '16');
  });

  it('switches a bound candidate on this conversation only and preserves ordinary models', async () => {
  localStorage.setItem('aqbot_conv_role_models_conv-1', JSON.stringify([
    { provider_id: 'provider-1', model_id: 'gpt-5.4' },
    { provider_id: 'provider-1', model_id: 'missing' },
  ]));
  render(<ModelSelector open onOpenChange={vi.fn()} />);
  expect(screen.getByText('chat.role.boundModels')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'OpenAI Compatible / missing' })).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'OpenAI Compatible / GPT 5.4' }));
  await waitFor(() => expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', {
    provider_id: 'provider-1', model_id: 'gpt-5.4', multi_model_targets: [],
  }));
  expect(mocks.saveSettings).not.toHaveBeenCalled();
  expect(screen.getAllByText('GPT 5.4').length).toBeGreaterThan(0);
});

  it('renders assistant models with the same model row details and pin/hover behavior', () => {
    providers[0].models.push({ ...providers[0].models[0], model_id: 'other-chat', name: 'Other Chat' });
    localStorage.setItem('aqbot_conv_role_models_conv-1', JSON.stringify([
      { provider_id: 'provider-1', model_id: 'gpt-5.4' },
      { provider_id: 'provider-1', model_id: 'other-chat' },
    ]));
    render(<ModelSelector open onOpenChange={vi.fn()} />);
    const section = screen.getByRole('region', { name: 'chat.role.boundModels' });
    const manage = within(section).getByRole('button', { name: 'chat.role.manage' });
    expect(manage.parentElement).toBe(within(section).getByText('chat.role.boundModels').parentElement);
    const selected = within(section).getByRole('button', { name: 'OpenAI Compatible / GPT 5.4' });
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(selected).toHaveStyle({ backgroundColor: '#e6f4ff' });
    expect(within(selected).getByTestId('model-icon')).toHaveTextContent('gpt-5.4');
    expect(within(selected).getByText('GPT 5.4')).toBeInTheDocument();
    expect(within(selected).getByText('OpenAI Compatible')).toBeInTheDocument();
    expect(within(selected).getByText('128K')).toBeInTheDocument();
    expect(selected.querySelector('.lucide-message-square')).toBeInTheDocument();
    const other = within(section).getByRole('button', { name: 'OpenAI Compatible / Other Chat' });
    fireEvent.mouseEnter(other);
    expect(other).toHaveStyle({ backgroundColor: '#f5f5f5' });
    fireEvent.mouseLeave(other);
    expect(other).not.toHaveStyle({ backgroundColor: '#f5f5f5' });
    const pin = other.querySelector('.lucide-pin')?.parentElement;
    expect(pin).toBeInTheDocument();
    fireEvent.click(pin!);
    expect(JSON.parse(localStorage.getItem('aqbot_pinned_models')!)).toEqual(['provider-1::other-chat']);
    expect(other.querySelector('.lucide-pin-off')).toBeInTheDocument();
    expect(mocks.updateConversation).not.toHaveBeenCalled();
  });

  it('closes the model selector before opening assistant management', () => {
    localStorage.setItem('aqbot_conv_role_models_conv-1', JSON.stringify([
      { provider_id: 'provider-1', model_id: 'gpt-5.4' },
    ]));
    const onOpenChange = vi.fn();
    render(<ModelSelector open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.role.manage' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.setActivePage).toHaveBeenCalledWith('roles');
    expect(onOpenChange.mock.invocationCallOrder[0]).toBeLessThan(mocks.setActivePage.mock.invocationCallOrder[0]);
  });

  it('keeps unavailable candidate disabled and reports switch errors visibly', async () => {
    localStorage.setItem('aqbot_conv_role_models_conv-1', JSON.stringify([
      { provider_id: 'provider-1', model_id: 'gpt-5.4' },
      { provider_id: 'missing', model_id: 'gone' },
    ]));
    const failure = new Error('save failed');
    mocks.updateConversation.mockRejectedValueOnce(failure);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ModelSelector open onOpenChange={vi.fn()} />);
    const unavailable = screen.getByRole('button', { name: 'missing / gone' });
    fireEvent.click(unavailable);
    fireEvent.keyDown(unavailable, { key: 'Enter' });
    expect(mocks.updateConversation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI Compatible / GPT 5.4' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('roles.applyFailed');
    expect(errorLog).toHaveBeenCalledWith('[RoleModelCandidates] failed to switch model', failure);
    errorLog.mockRestore();
  });

});
