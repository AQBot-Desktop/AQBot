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
const loadKnowledgeBases = vi.fn();
const toggleKnowledgeBase = vi.fn();
const loadMemoryNamespaces = vi.fn();
const toggleMemoryNamespace = vi.fn();
const setThinkingBudget = vi.fn();
const setThinkingLevel = vi.fn();
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
  enabledKnowledgeBaseIds: [] as string[],
  toggleKnowledgeBase,
  enabledMemoryNamespaceIds: [] as string[],
  toggleMemoryNamespace,
  thinkingBudget: null as number | null,
  thinkingLevel: null as string | null,
  setThinkingBudget,
  setThinkingLevel,
  insertContextClear,
};

const providerState = {
  providers: [
    {
      id: 'provider-1',
      provider_type: 'gemini',
      enabled: true,
      models: [
        {
          provider_id: 'provider-1',
          model_id: 'model-1',
          name: 'model-1',
          model_type: 'Chat',
          enabled: true,
          capabilities: [] as string[],
          max_tokens: 128000,
          param_overrides: null,
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

const knowledgeState = {
  bases: [],
  loadBases: loadKnowledgeBases,
};

const memoryState = {
  namespaces: [],
  loadNamespaces: loadMemoryNamespaces,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/stores', () => ({
  useConversationStore: Object.assign(
    (selector: (state: typeof conversationState) => unknown) => selector(conversationState),
    { getState: () => conversationState },
  ),
  useProviderStore: Object.assign(
    (selector: (state: typeof providerState) => unknown) => selector(providerState),
    { getState: () => providerState },
  ),
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
  useSearchStore: (selector: (state: typeof searchState) => unknown) => selector(searchState),
  useMcpStore: (selector: (state: typeof mcpState) => unknown) => selector(mcpState),
  useKnowledgeStore: (selector: (state: typeof knowledgeState) => unknown) => selector(knowledgeState),
  useMemoryStore: (selector: (state: typeof memoryState) => unknown) => selector(memoryState),
}));

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: { setActivePage: typeof setActivePage; setSettingsSection: typeof setSettingsSection }) => unknown) =>
    selector({ setActivePage, setSettingsSection }),
}));

vi.mock('@/lib/modelCapabilities', () => ({
  findModelByIds: (providers: typeof providerState.providers, providerId: string, modelId: string) =>
    providers.find((provider) => provider.id === providerId)?.models.find((model) => model.model_id === modelId) ?? null,
  supportsReasoning: (model: { capabilities?: string[] } | null | undefined) => model?.capabilities?.includes('Reasoning') ?? false,
  modelHasCapability: (model: { capabilities?: string[] } | null | undefined, capability: string) =>
    model?.capabilities?.includes(capability) ?? false,
}));

vi.mock('@/components/shared/SearchProviderIcon', () => ({
  SearchProviderTypeIcon: () => null,
  PROVIDER_TYPE_LABELS: {
    tavily: 'Tavily',
  },
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => null,
}));

vi.mock('../VoiceCall', () => ({
  VoiceCall: () => null,
}));

vi.mock('../ConversationSettingsModal', () => ({
  ConversationSettingsModal: () => null,
}));

vi.mock('../ModelSelector', () => ({
  ModelSelector: () => null,
}));

describe('InputArea', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerState.providers[0].provider_type = 'gemini';
    providerState.providers[0].models[0].model_id = 'model-1';
    providerState.providers[0].models[0].name = 'model-1';
    providerState.providers[0].models[0].capabilities = [];
    providerState.providers[0].models[0].param_overrides = null;
    conversationState.conversations[0].model_id = 'model-1';
    conversationState.thinkingBudget = null;
    conversationState.thinkingLevel = null;
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

  it('renders model-specific reasoning options for Gemini 3.1 models', async () => {
    providerState.providers[0].provider_type = 'gemini';
    providerState.providers[0].models[0].model_id = 'gemini-3.1-flash';
    providerState.providers[0].models[0].name = 'Gemini 3.1 Flash';
    providerState.providers[0].models[0].capabilities = ['Reasoning'];
    conversationState.conversations[0].model_id = 'gemini-3.1-flash';

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(screen.getByLabelText('chat.thinkingIntensity'));

    expect(await screen.findByText('Minimal')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.queryByText('XHigh')).not.toBeInTheDocument();
  });
});
