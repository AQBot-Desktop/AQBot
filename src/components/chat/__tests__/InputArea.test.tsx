import { App } from 'antd';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../InputArea';

const sendMessage = vi.fn();
const createConversation = vi.fn();
const setSearchEnabled = vi.fn();
const setSearchProviderId = vi.fn();
const loadSearchProviders = vi.fn();
const loadMcpServers = vi.fn();
const toggleMcpServer = vi.fn();
const setThinkingBudget = vi.fn();
const insertContextClear = vi.fn();
const setActivePage = vi.fn();
const setSettingsSection = vi.fn();

const conversationState = {
  streaming: false,
  activeConversationId: 'conv-1',
  sendMessage,
  createConversation,
  messages: [],
  conversations: [
    {
      id: 'conv-1',
      title: 'Test',
      provider_id: 'provider-1',
      model_id: 'model-1',
    },
  ],
  searchEnabled: true,
  searchProviderId: 'search-1',
  setSearchEnabled,
  setSearchProviderId,
  enabledMcpServerIds: [] as string[],
  toggleMcpServer,
  thinkingBudget: null as number | null,
  setThinkingBudget,
  insertContextClear,
};

const providerState = {
  providers: [
    {
      id: 'provider-1',
      enabled: true,
      models: [
        {
          model_id: 'model-1',
          enabled: true,
          capabilities: [],
        },
      ],
    },
  ],
};

const settingsState = {
  settings: {
    default_provider_id: null,
    default_model_id: null,
  },
};

const searchState = {
  providers: [
    {
      id: 'search-1',
      name: 'Test Search',
      providerType: 'tavily',
    },
  ],
  loadProviders: loadSearchProviders,
};

const mcpState = {
  servers: [],
  loadServers: loadMcpServers,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/stores', () => ({
  useConversationStore: (selector: (state: typeof conversationState) => unknown) => selector(conversationState),
  useProviderStore: (selector: (state: typeof providerState) => unknown) => selector(providerState),
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
  useSearchStore: (selector: (state: typeof searchState) => unknown) => selector(searchState),
  useMcpStore: (selector: (state: typeof mcpState) => unknown) => selector(mcpState),
}));

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: { setActivePage: typeof setActivePage; setSettingsSection: typeof setSettingsSection }) => unknown) =>
    selector({ setActivePage, setSettingsSection }),
}));

vi.mock('@/lib/modelCapabilities', () => ({
  findModelByIds: () => ({
    model_id: 'model-1',
    capabilities: [],
  }),
  supportsReasoning: () => false,
}));

vi.mock('@/components/shared/SearchProviderIcon', () => ({
  SearchProviderTypeIcon: () => null,
  PROVIDER_TYPE_LABELS: {
    tavily: 'Tavily',
  },
}));

vi.mock('../VoiceCall', () => ({
  VoiceCall: () => null,
}));

vi.mock('../ConversationSettingsModal', () => ({
  ConversationSettingsModal: () => null,
}));

describe('InputArea', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the textarea immediately after sending even while search-backed send is still pending', async () => {
    let resolveSend!: () => void;
    sendMessage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );

    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    await userEvent.type(textarea, 'search me');

    expect(textarea.value).toBe('search me');

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(sendMessage).toHaveBeenCalledWith('search me', undefined, 'search-1');
    expect(textarea.value).toBe('');

    resolveSend();
  });
});
