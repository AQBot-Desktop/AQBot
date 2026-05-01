import type React from 'react';
import { render, screen } from '@testing-library/react';
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

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'OpenAI Compatible',
    provider_type: 'openai',
    api_host: 'https://api.example.com',
    api_path: '/v1/chat/completions',
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
    is_pinned: false,
    is_archived: false,
    context_compression: false,
    category_id: null,
    parent_conversation_id: null,
    mode: 'chat',
    message_count: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => <span data-testid="model-icon" />,
}));

vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('@/lib/shortcuts', () => ({
  getShortcutBinding: () => null,
  formatShortcutForDisplay: () => '',
}));

vi.mock('@/lib/modelCapabilities', () => ({
  getVisibleModelCapabilities: () => [],
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
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: React.MouseEventHandler<HTMLButtonElement> }) => (
    <button onClick={onClick}>{children}</button>
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
      settings: {
        default_provider_id: null,
        default_model_id: null,
      },
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
            max_tokens: 128000,
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
            max_tokens: null,
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
            max_tokens: null,
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
            max_tokens: null,
            enabled: true,
            param_overrides: null,
          },
        ],
      }),
    ];
    conversations = [makeConversation()];
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
});
