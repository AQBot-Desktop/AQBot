import { App } from 'antd';
import { Activity } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Message } from '@/types';
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
const clearAllMessages = vi.fn();
const clearFirstRounds = vi.fn();
const getContextUsage = vi.fn();
const setActivePage = vi.fn();
const setSettingsSection = vi.fn();

const conversationState = {
  streaming: false,
  compressingConversationId: null as string | null,
  activeConversationId: 'conv-1' as string | null,
  loading: false,
  sendMessage,
  createConversation,
  messages: [] as Message[],
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
  clearAllMessages,
  clearFirstRounds,
  getContextUsage,
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

const settingsState: { settings: Partial<AppSettings> } = {
  settings: {
    default_provider_id: null,
    default_model_id: null,
    document_attachment_reading_enabled: false,
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
  ensureProvidersLoaded: loadSearchProviders,
};

const mcpState = {
  servers: [],
  ensureServersLoaded: loadMcpServers,
};

const knowledgeState = {
  bases: [],
  ensureBasesLoaded: loadKnowledgeBases,
};

const memoryState = {
  namespaces: [],
  ensureNamespacesLoaded: loadMemoryNamespaces,
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

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async () => () => {}),
  }),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
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
    conversationState.compressingConversationId = null;
    conversationState.messages = [];
    conversationState.activeConversationId = 'conv-1';
    conversationState.loading = false;
    conversationState.streaming = false;
    getContextUsage.mockResolvedValue(null);
    settingsState.settings.document_attachment_reading_enabled = false;
  });

  const waitForNextFrame = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

  it('preserves a new-conversation draft across an Activity suspend and resume', async () => {
    conversationState.activeConversationId = null;
    const user = userEvent.setup();
    const renderInput = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <App>
          <InputArea />
        </App>
      </Activity>
    );
    const view = render(renderInput('visible'));

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await user.type(textarea, '保留未发送草稿');

    view.rerender(renderInput('hidden'));
    view.rerender(renderInput('visible'));

    expect(screen.getByPlaceholderText('chat.inputPlaceholder')).toHaveValue('保留未发送草稿');
  });

  it('focuses the chat textarea when the window regains focus without another active input', async () => {
    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);

    window.dispatchEvent(new Event('focus'));
    await waitForNextFrame();

    expect(document.activeElement).toBe(textarea);
  });

  it('does not steal focus from another focused input when the window regains focus', async () => {
    render(
      <>
        <App>
          <InputArea />
        </App>
        <input aria-label="external-input" />
      </>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    const externalInput = screen.getByLabelText('external-input') as HTMLInputElement;
    externalInput.focus();
    expect(document.activeElement).toBe(externalInput);

    window.dispatchEvent(new Event('focus'));
    await waitForNextFrame();

    expect(document.activeElement).toBe(externalInput);
    expect(document.activeElement).not.toBe(textarea);
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

  it('renders DeepSeek V4 reasoning options from the provider profile', async () => {
    providerState.providers[0].provider_type = 'deepseek';
    providerState.providers[0].models[0].model_id = 'deepseek-v4-flash';
    providerState.providers[0].models[0].name = 'DeepSeek v4 Flash';
    providerState.providers[0].models[0].capabilities = ['Reasoning'];
    conversationState.conversations[0].model_id = 'deepseek-v4-flash';

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(screen.getByLabelText('chat.thinkingIntensity'));

    expect(await screen.findByText('High')).toBeInTheDocument();
    expect(screen.getByText('Max')).toBeInTheDocument();
    expect(screen.queryByText('Low')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
    expect(screen.queryByText('XHigh')).not.toBeInTheDocument();
  });

  it('shows backend context usage instead of a loaded-message estimate', async () => {
    getContextUsage.mockResolvedValueOnce({
      used_tokens: 720000,
      max_tokens: 1000000,
      threshold_tokens: 700000,
      has_summary: true,
      compressed_until_message_id: 'msg-1',
      messages_after_boundary: 3,
    });

    render(
      <App>
        <InputArea />
      </App>,
    );

    await waitFor(() => expect(getContextUsage).toHaveBeenCalledWith('conv-1'));
    await userEvent.hover(screen.getByLabelText('上下文 tokens'));

    expect(await screen.findByText('720,000 / 1,000,000 tokens (72%)')).toBeInTheDocument();
  });

  it('does not refetch context usage while a conversation switch is still loading messages', async () => {
    vi.useFakeTimers();
    try {
      conversationState.loading = true;
      conversationState.messages = [];
      getContextUsage.mockResolvedValue({
        used_tokens: 12,
        max_tokens: 100,
        threshold_tokens: 70,
        has_summary: false,
        compressed_until_message_id: null,
        messages_after_boundary: 1,
      });

      const { rerender } = render(
        <App>
          <InputArea />
        </App>,
      );

      conversationState.messages = [{
        id: 'msg-1',
        conversation_id: 'conv-1',
        role: 'user',
        content: 'hello',
        provider_id: null,
        model_id: null,
        token_count: null,
        attachments: [],
        thinking: null,
        tool_calls_json: null,
        tool_call_id: null,
        created_at: 1,
        parent_message_id: null,
        version_index: 0,
        is_active: true,
        status: 'complete',
      }];
      rerender(
        <App>
          <InputArea />
        </App>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(220);
      });
      expect(getContextUsage).not.toHaveBeenCalled();

      conversationState.loading = false;
      rerender(
        <App>
          <InputArea />
        </App>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(220);
      });

      expect(getContextUsage).toHaveBeenCalledTimes(1);
      expect(getContextUsage).toHaveBeenCalledWith('conv-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows document attachment controls for non-vision models when document reading is enabled', () => {
    settingsState.settings.document_attachment_reading_enabled = true;

    render(
      <App>
        <InputArea />
      </App>,
    );

    expect(screen.getByLabelText('chat.attachFile')).toBeInTheDocument();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input?.accept).toContain('.pdf');
    expect(input?.accept).toContain('.doc');
    expect(input?.accept).toContain('.docx');
  });

  it('keeps the clear-all action in the clear conversation menu', async () => {
    conversationState.messages = [{ id: 'msg-1', content: 'hello' } as any];

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(screen.getByLabelText('chat.clearConversation'));
    await userEvent.click(await screen.findByText('chat.clearConversationAll'));
    await userEvent.click(await screen.findByText('common.confirm'));

    expect(clearAllMessages).toHaveBeenCalledTimes(1);
  });

  it('clears the first N rounds from the clear conversation menu', async () => {
    conversationState.messages = [{ id: 'msg-1', content: 'hello' } as any];

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(screen.getByLabelText('chat.clearConversation'));
    await userEvent.click(await screen.findByText('chat.clearFirstRounds'));
    const input = await screen.findByRole('spinbutton');
    await userEvent.clear(input);
    await userEvent.type(input, '2');
    await userEvent.click(await screen.findByText('common.confirm'));

    expect(clearFirstRounds).toHaveBeenCalledWith(2);
  });

  it('disables the clear conversation menu without an active conversation', () => {
    conversationState.activeConversationId = null;
    conversationState.messages = [{ id: 'msg-1', content: 'hello' } as any];

    render(
      <App>
        <InputArea />
      </App>,
    );

    expect(screen.getByLabelText('chat.clearConversation')).toBeDisabled();
  });
});
