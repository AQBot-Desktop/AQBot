import { App } from 'antd';
import { Activity } from 'react';
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, McpServer, Message } from '@/types';
import { InputArea } from '../InputArea';

const sendMessage = vi.fn();
const sendMultiModelMessage = vi.fn();
const sendAgentMessage = vi.fn();
const createConversation = vi.fn();
const updateQueuedChatMessage = vi.fn();
const removeQueuedChatMessage = vi.fn();
const sendQueuedChatMessageNow = vi.fn();
const cancelCurrentStream = vi.fn();
const setPendingPromptText = vi.fn();
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
const enterSettings = vi.fn();
const setSettingsSection = vi.fn();
const setSelectedProviderId = vi.fn();
const updateConversation = vi.fn();
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

const conversationState = {
  streaming: false,
  compressingConversationId: null as string | null,
  activeConversationId: 'conv-1' as string | null,
  loading: false,
  error: null as string | null,
  submitChatMessage: sendMessage,
  sendMultiModelMessage,
  sendAgentMessage,
  updateQueuedChatMessage,
  removeQueuedChatMessage,
  sendQueuedChatMessageNow,
  cancelCurrentStream,
  createConversation,
  chatQueueByConversation: {} as Record<string, any>,
  pendingPromptText: null as string | null,
  setPendingPromptText,
  messages: [] as Message[],
  conversations: [
    {
      id: 'conv-1',
      title: 'Test',
      provider_id: 'provider-1',
      model_id: 'model-1',
      mode: 'chat' as 'chat' | 'agent',
    },
  ],
  archivedConversations: [] as any[],
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
  multiModelTargets: [] as Array<{ providerId: string; modelId: string }>,
  multiModelContinuationMode: 'selected' as 'selected' | 'per_model',
  setMultiModelTargets: (targets: Array<{ providerId: string; modelId: string }>) => {
    conversationState.multiModelTargets = targets;
  },
  setMultiModelContinuationMode: (mode: 'selected' | 'per_model') => {
    conversationState.multiModelContinuationMode = mode;
  },
  setThinkingBudget,
  setThinkingLevel,
  insertContextClear,
  clearAllMessages,
  clearFirstRounds,
  getContextUsage,
  updateConversation,
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
          context_window: 128000,
          param_overrides: null,
        },
      ],
    },
    {
      id: 'provider-2',
      provider_type: 'openai',
      enabled: true,
      models: [
        {
          provider_id: 'provider-2',
          model_id: 'model-1',
          name: 'model-1-b',
          model_type: 'Chat',
          enabled: true,
          capabilities: [] as string[],
          context_window: 128000,
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
    chat_input_actions_scale: 100,
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

const mcpState: {
  servers: McpServer[];
  ensureServersLoaded: typeof loadMcpServers;
} = {
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
    t: (key: string, options?: string | Record<string, unknown>) => {
      const thinkingLabels: Record<string, string> = {
        'chat.thinking.default': 'Default',
        'chat.thinking.off': 'Off',
        'chat.thinking.minimal': 'Minimal',
        'chat.thinking.none': 'No Reasoning',
        'chat.thinking.low': 'Low',
        'chat.thinking.medium': 'Medium',
        'chat.thinking.high': 'High',
        'chat.thinking.xhigh': 'XHigh',
        'chat.thinking.max': 'Max',
        'chat.thinking.followUnified': 'Follow unified',
      };
      if (thinkingLabels[key]) return thinkingLabels[key];
      if (typeof options === 'string') return options;
      if (options && typeof options === 'object') {
        if (key === 'chat.pastedTextLabel') {
          return `Pasted text #${options.n} · ${options.lines} lines`;
        }
        if (typeof options.defaultValue === 'string') return options.defaultValue;
      }
      if (key === 'chat.contextTokenUsage') return '上下文 tokens';
      return key;
    },
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
  useRoleStore: Object.assign(
    (selector: (state: { roles: []; ensureRolesLoaded: () => Promise<void> }) => unknown) =>
      selector({ roles: [], ensureRolesLoaded: async () => {} }),
    { getState: () => ({ roles: [] }) },
  ),
  useSkillStore: Object.assign(
    (selector: (state: {
      skills: [];
      skillsMeta: { status: string };
      ensureSkillsLoaded: () => Promise<void>;
      toggleSkill: () => Promise<void>;
    }) => unknown) =>
      selector({
        skills: [],
        skillsMeta: { status: 'ready' },
        ensureSkillsLoaded: async () => {},
        toggleSkill: async () => {},
      }),
    { getState: () => ({ skills: [], skillsMeta: { status: 'ready' } }) },
  ),
}));

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: (state: {
    setActivePage: typeof setActivePage;
    enterSettings: typeof enterSettings;
    setSettingsSection: typeof setSettingsSection;
    setSelectedProviderId: typeof setSelectedProviderId;
  }) => unknown) => selector({
    setActivePage,
    enterSettings,
    setSettingsSection,
    setSelectedProviderId,
  }),
}));

vi.mock('@/lib/modelCapabilities', () => ({
  findModelByIds: (providers: typeof providerState.providers, providerId: string, modelId: string) =>
    providers.find((provider) => provider.id === providerId)?.models.find((model) => model.model_id === modelId) ?? null,
  supportsReasoning: (model: { capabilities?: string[] } | null | undefined) => model?.capabilities?.includes('Reasoning') ?? false,
  supportsFunctionCalling: (model: { capabilities?: string[] } | null | undefined) =>
    model?.capabilities?.includes('FunctionCalling') ?? false,
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

vi.mock('@/lib/invoke', () => ({
  invoke,
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
    localStorage.clear();
    providerState.providers.splice(2);
    providerState.providers[0].enabled = true;
    providerState.providers[1].enabled = true;
    providerState.providers[0].provider_type = 'gemini';
    providerState.providers[0].models[0].model_id = 'model-1';
    providerState.providers[0].models[0].name = 'model-1';
    providerState.providers[0].models[0].capabilities = [];
    providerState.providers[0].models[0].param_overrides = null;
    conversationState.conversations[0].model_id = 'model-1';
    conversationState.conversations[0].mode = 'chat';
    conversationState.thinkingBudget = null;
    conversationState.thinkingLevel = null;
    conversationState.compressingConversationId = null;
    conversationState.messages = [];
    conversationState.activeConversationId = 'conv-1';
    conversationState.loading = false;
    conversationState.streaming = false;
    conversationState.pendingPromptText = null;
    conversationState.multiModelTargets = [];
    conversationState.multiModelContinuationMode = 'selected';
    conversationState.error = null;
    conversationState.chatQueueByConversation = {};
    conversationState.enabledMcpServerIds = [];
    mcpState.servers = [];
    sendMessage.mockResolvedValue({ kind: 'started', message: {} });
    sendAgentMessage.mockResolvedValue(undefined);
    sendQueuedChatMessageNow.mockResolvedValue(true);
    getContextUsage.mockResolvedValue(null);
    updateConversation.mockResolvedValue(undefined);
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === 'agent_update_session') return { cwd: null };
      if (command === 'agent_ensure_workspace') return '/tmp/workspace-conv-1';
      if (command === 'agent_get_session') return null;
      return undefined;
    });
    settingsState.settings.default_provider_id = null;
    settingsState.settings.default_model_id = null;
    settingsState.settings.document_attachment_reading_enabled = false;
    settingsState.settings.chat_input_actions_scale = 100;
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

  it('shows compression loading only for a matching non-null active conversation', () => {
    const renderInput = () => (
      <App>
        <InputArea />
      </App>
    );

    conversationState.activeConversationId = null;
    conversationState.compressingConversationId = null;
    const view = render(renderInput());
    expect(screen.getByLabelText('chat.contextStrategyActive')).not.toHaveClass('ant-btn-loading');

    conversationState.activeConversationId = 'conv-1';
    conversationState.compressingConversationId = 'conv-1';
    view.rerender(renderInput());
    expect(screen.getByLabelText('chat.contextStrategyActive')).toHaveClass('ant-btn-loading');

    conversationState.compressingConversationId = 'conv-2';
    view.rerender(renderInput());
    expect(screen.getByLabelText('chat.contextStrategyActive')).not.toHaveClass('ant-btn-loading');
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

  it('scales all four bottom action groups without scaling the textarea', () => {
    const view = render(
      <App>
        <InputArea />
      </App>,
    );

    const actionGroupIds = [
      'input-actions-primary',
      'input-actions-send',
      'input-actions-mode',
      'input-actions-status',
    ];
    const expectActionScale = (expected: string) => {
      for (const testId of actionGroupIds) {
        expect(screen.getByTestId(testId).style.getPropertyValue('zoom')).toBe(expected);
      }
    };

    expectActionScale('1');
    expect(
      (screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLElement)
        .style
        .getPropertyValue('zoom'),
    ).toBe('');

    settingsState.settings.chat_input_actions_scale = 50;
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    expectActionScale('0.5');

    settingsState.settings.chat_input_actions_scale = 150;
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    expectActionScale('1.5');
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

  it('clears the textarea only after the unified submit accepts the message', async () => {
    let resolveSend!: (result: { kind: 'started'; message: object }) => void;
    sendMessage.mockImplementationOnce(
      () =>
        new Promise<{ kind: 'started'; message: object }>((resolve) => {
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
    expect(textarea.value).toBe('search me');

    resolveSend({ kind: 'started', message: {} });
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it('submits the same composer snapshot only once while acceptance is pending', async () => {
    let resolveSend!: (result: { kind: 'queued'; queueId: string }) => void;
    sendMessage.mockImplementationOnce(
      () => new Promise<{ kind: 'queued'; queueId: string }>((resolve) => {
        resolveSend = resolve;
      }),
    );

    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await userEvent.type(textarea, 'send exactly once');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    resolveSend({ kind: 'queued', queueId: 'queue-once' });
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('does not clear a newer draft typed while submit is pending', async () => {
    let resolveSend!: (result: { kind: 'queued'; queueId: string }) => void;
    sendMessage.mockImplementationOnce(
      () => new Promise<{ kind: 'queued'; queueId: string }>((resolve) => {
        resolveSend = resolve;
      }),
    );

    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await userEvent.type(textarea, 'first draft');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    await userEvent.type(textarea, ' plus newer text');

    resolveSend({ kind: 'queued', queueId: 'queue-1' });

    await waitFor(() => expect(textarea).toHaveValue('first draft plus newer text'));
    fireEvent.change(textarea, { target: { value: '' } });
  });

  it('keeps the full composer when a newly created conversation rejects after switching in', async () => {
    conversationState.activeConversationId = null;
    settingsState.settings.document_attachment_reading_enabled = true;
    let resolveSubmit!: (result: { kind: 'rejected'; reason: 'invalid-message' }) => void;
    sendMessage.mockImplementationOnce(
      () => new Promise<{ kind: 'rejected'; reason: 'invalid-message' }>((resolve) => {
        resolveSubmit = resolve;
      }),
    );
    createConversation.mockImplementationOnce(async () => {
      conversationState.activeConversationId = 'conv-created';
      return { id: 'conv-created' };
    });

    const view = render(
      <App>
        <InputArea />
      </App>,
    );

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const longText = Array.from({ length: 45 }, (_, index) => `line ${index + 1}`).join('\n');
    await user.upload(fileInput, new File(['notes'], 'new-chat.txt', { type: 'text/plain' }));
    await user.type(textarea, 'new conversation ');
    pastePlainText(textarea, longText);
    await user.click(screen.getByLabelText('chat.sendMessage'));

    await waitFor(() => expect(createConversation).toHaveBeenCalled());
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    resolveSubmit({ kind: 'rejected', reason: 'invalid-message' });

    await waitFor(() => expect(textarea).toHaveValue('new conversation [[paste:#1]]'));
    expect(screen.getByText(/Pasted text #1/)).toBeInTheDocument();
    expect(screen.getByText('new-chat.txt')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: '' } });
  });

  it('clears a quickly accepted draft after creating its conversation', async () => {
    conversationState.activeConversationId = null;
    createConversation.mockImplementationOnce(async () => {
      conversationState.activeConversationId = 'conv-created';
      return { id: 'conv-created' };
    });
    sendMessage.mockResolvedValueOnce({ kind: 'queued', queueId: 'created-queue' });
    const view = render(
      <App>
        <InputArea />
      </App>,
    );
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await userEvent.type(textarea, 'send immediately after create');

    await userEvent.click(screen.getByLabelText('chat.sendMessage'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      'send immediately after create',
      undefined,
      'search-1',
    ));
    await waitFor(() => expect(textarea).toHaveValue(''));

    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    expect(textarea).toHaveValue('');
  });

  it('does not submit an attachment-backed draft into a conversation selected during conversion', async () => {
    settingsState.settings.document_attachment_reading_enabled = true;
    let finishRead: (() => void) | undefined;
    const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
      .mockImplementation(function deferRead(this: FileReader) {
        finishRead = () => {
          Object.defineProperty(this, 'result', {
            configurable: true,
            value: 'data:text/plain;base64,bm90ZXM=',
          });
          this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
        };
      });

    const view = render(
      <App>
        <InputArea />
      </App>,
    );
    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['notes'], 'slow.txt', { type: 'text/plain' }));
    await user.type(textarea, 'draft for conversation A');
    await user.click(screen.getByLabelText('chat.sendMessage'));
    await waitFor(() => expect(finishRead).toBeTypeOf('function'));

    conversationState.activeConversationId = 'conv-2';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
    finishRead?.();

    expect(await screen.findByText('chat.inputQueue.conversationChanged')).toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();

    conversationState.activeConversationId = 'conv-1';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    await waitFor(() => expect(textarea).toHaveValue('draft for conversation A'));
    expect(screen.getByText('slow.txt')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: '' } });
    readSpy.mockRestore();
  });

  it('removes an accepted inactive-conversation draft from its text, attachment, and snippet caches', async () => {
    settingsState.settings.document_attachment_reading_enabled = true;
    let resolveSubmit!: (result: { kind: 'queued'; queueId: string }) => void;
    sendMessage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSubmit = resolve;
    }));
    const view = render(
      <App>
        <InputArea />
      </App>,
    );
    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const longText = Array.from({ length: 45 }, (_, index) => `cached line ${index + 1}`).join('\n');
    await user.upload(fileInput, new File(['notes'], 'accepted-a.txt', { type: 'text/plain' }));
    await user.type(textarea, 'accepted A ');
    pastePlainText(textarea, longText);
    await user.click(screen.getByLabelText('chat.sendMessage'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());

    conversationState.activeConversationId = 'conv-2';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
    resolveSubmit({ kind: 'queued', queueId: 'accepted-a' });
    await waitFor(() => expect(screen.queryByText('accepted-a.txt')).not.toBeInTheDocument());

    conversationState.activeConversationId = 'conv-1';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );

    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(screen.queryByText('accepted-a.txt')).not.toBeInTheDocument();
    expect(screen.queryByText(/Pasted text #1/)).not.toBeInTheDocument();
  });

  it('cleans an accepted draft when the store switches conversations before the switch effect runs', async () => {
    settingsState.settings.document_attachment_reading_enabled = true;
    let resolveSubmit!: (result: { kind: 'queued'; queueId: string }) => void;
    sendMessage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSubmit = resolve;
    }));
    const view = render(
      <App>
        <InputArea />
      </App>,
    );
    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const longText = Array.from({ length: 45 }, (_, index) => `race line ${index + 1}`).join('\n');
    await user.upload(fileInput, new File(['race'], 'accepted-race.txt', { type: 'text/plain' }));
    await user.type(textarea, 'accepted race ');
    pastePlainText(textarea, longText);
    await user.click(screen.getByLabelText('chat.sendMessage'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());

    conversationState.activeConversationId = 'conv-2';
    resolveSubmit({ kind: 'queued', queueId: 'accepted-race' });
    await act(async () => {});
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    await waitFor(() => expect(textarea).toHaveValue(''));

    conversationState.activeConversationId = 'conv-1';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(screen.queryByText('accepted-race.txt')).not.toBeInTheDocument();
    expect(screen.queryByText(/Pasted text #1/)).not.toBeInTheDocument();
  });

  it('clears an unchanged accepted draft after switching away and back before acceptance', async () => {
    settingsState.settings.document_attachment_reading_enabled = true;
    let resolveSubmit!: (result: { kind: 'queued'; queueId: string }) => void;
    sendMessage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSubmit = resolve;
    }));
    const view = render(
      <App>
        <InputArea />
      </App>,
    );
    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const longText = Array.from({ length: 45 }, (_, index) => `roundtrip line ${index + 1}`).join('\n');
    await user.upload(fileInput, new File(['roundtrip'], 'roundtrip.txt', { type: 'text/plain' }));
    await user.type(textarea, 'roundtrip A ');
    pastePlainText(textarea, longText);
    await user.click(screen.getByLabelText('chat.sendMessage'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());

    conversationState.activeConversationId = 'conv-2';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
    conversationState.activeConversationId = 'conv-1';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    await waitFor(() => expect(textarea).toHaveValue('roundtrip A [[paste:#1]]'));
    expect(screen.getByText('roundtrip.txt')).toBeInTheDocument();

    resolveSubmit({ kind: 'queued', queueId: 'roundtrip-accepted' });

    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(screen.queryByText('roundtrip.txt')).not.toBeInTheDocument();
    expect(screen.queryByText(/Pasted text #1/)).not.toBeInTheDocument();
  });

  it('queues a normal single-model message while keeping the stop control visible', async () => {
    conversationState.streaming = true;
    sendMessage.mockResolvedValueOnce({ kind: 'queued', queueId: 'queue-1' });

    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await userEvent.type(textarea, 'queue this next');

    expect(screen.getByLabelText('common.stop')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('chat.inputQueue.enqueue'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      'queue this next',
      undefined,
      'search-1',
    ));
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(screen.getByLabelText('common.stop')).toBeInTheDocument();
  });

  it('queues an ordinary message with Enter while streaming', async () => {
    conversationState.streaming = true;
    sendMessage.mockResolvedValueOnce({ kind: 'queued', queueId: 'queue-enter' });
    render(
      <App>
        <InputArea />
      </App>,
    );
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await userEvent.type(textarea, 'queue by enter');

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      'queue by enter',
      undefined,
      'search-1',
    ));
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(screen.getByLabelText('common.stop')).toBeInTheDocument();
  });

  it('does not submit a composing IME Enter keypress', async () => {
    conversationState.streaming = true;
    render(
      <App>
        <InputArea />
      </App>,
    );
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await userEvent.type(textarea, '输入中');
    const composingEnter = createEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
    });
    Object.defineProperty(composingEnter, 'isComposing', { value: true });

    fireEvent(textarea, composingEnter);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('输入中');
    fireEvent.change(textarea, { target: { value: '' } });
  });

  it('keeps the draft and explains when another conversation blocks submission', async () => {
    sendMessage.mockResolvedValueOnce({
      kind: 'rejected',
      reason: 'other-conversation-busy',
    });

    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await userEvent.type(textarea, 'do not lose this');
    await userEvent.click(screen.getByLabelText('chat.sendMessage'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(textarea).toHaveValue('do not lose this');
    expect(await screen.findByText('chat.inputQueue.otherConversationBusy')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: '' } });
  });

  it.each([
    { mode: 'agent' as const, targets: [] },
    {
      mode: 'chat' as const,
      targets: [{ providerId: 'provider-1', modelId: 'model-1' }],
    },
  ])('hides send during $mode streaming when queuing is unsupported', ({ mode, targets }) => {
    conversationState.streaming = true;
    conversationState.conversations[0].mode = mode;
    conversationState.multiModelTargets = targets;

    render(
      <App>
        <InputArea />
      </App>,
    );

    expect(screen.getByLabelText('common.stop')).toBeInTheDocument();
    expect(screen.queryByLabelText('chat.sendMessage')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('chat.inputQueue.enqueue')).not.toBeInTheDocument();
  });

  it('clears the Agent composer after send starts', async () => {
    conversationState.conversations[0].mode = 'agent';
    sendAgentMessage.mockImplementation(async () => {
      conversationState.streaming = true;
    });

    const view = render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    fireEvent.change(textarea, { target: { value: '你好呀' } });
    await userEvent.click(screen.getByLabelText('chat.sendMessage'));

    await waitFor(() => {
      expect(sendAgentMessage).toHaveBeenCalledWith('你好呀', undefined);
    });
    expect(textarea).toHaveValue('');

    view.rerender(
      <App>
        <InputArea />
      </App>,
    );
    expect(screen.getByLabelText('common.stop')).toBeInTheDocument();
    expect(screen.queryByLabelText('chat.sendMessage')).not.toBeInTheDocument();
  });

  it('renders the active queue and wires send-now and delete actions', async () => {
    conversationState.chatQueueByConversation['conv-1'] = {
      messages: [{
        id: 'queue-1',
        conversationId: 'conv-1',
        content: 'queued from store',
        attachments: [],
        searchProviderId: null,
        status: 'queued',
        error: null,
        createdAt: 1,
        updatedAt: 1,
      }],
      phase: 'paused',
      paused: true,
      error: null,
    };

    render(
      <App>
        <InputArea />
      </App>,
    );

    const row = screen.getByTestId('queued-message-queue-1');
    await userEvent.click(within(row).getByLabelText('chat.inputQueue.sendNow'));
    await userEvent.click(within(row).getByLabelText('chat.inputQueue.delete'));

    expect(sendQueuedChatMessageNow).toHaveBeenCalledWith('conv-1', 'queue-1');
    expect(removeQueuedChatMessage).toHaveBeenCalledWith('conv-1', 'queue-1');
  });

  it('shows only messages still waiting in the active queue', () => {
    conversationState.chatQueueByConversation['conv-1'] = {
      messages: [
        {
          id: 'queue-sending',
          conversationId: 'conv-1',
          content: 'currently sending',
          attachments: [],
          searchProviderId: null,
          status: 'dispatching',
          error: null,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'queue-waiting',
          conversationId: 'conv-1',
          content: 'waiting to send',
          attachments: [],
          searchProviderId: null,
          status: 'queued',
          error: null,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      phase: 'dispatching',
      paused: false,
      error: null,
    };

    render(
      <App>
        <InputArea />
      </App>,
    );

    expect(screen.queryByTestId('queued-message-queue-sending')).not.toBeInTheDocument();
    expect(screen.queryByText('currently sending')).not.toBeInTheDocument();
    expect(screen.getByTestId('queued-message-queue-waiting')).toHaveTextContent('waiting to send');
    expect(screen.getAllByTestId(/^queued-message-/)).toHaveLength(1);
  });

  it('persists and sends the per-model follow-up mode for a multi-model request', async () => {
    conversationState.multiModelTargets = [
      { providerId: 'provider-1', modelId: 'model-1' },
      { providerId: 'provider-2', modelId: 'model-1' },
    ];

    render(
      <App>
        <InputArea />
      </App>,
    );

    expect(await screen.findByTestId('multi-model-follow-up-mode')).toBeInTheDocument();
    await userEvent.click(screen.getByText('chat.multiModel.followUpModePerModel'));
    expect(conversationState.multiModelContinuationMode).toBe('per_model');

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await userEvent.type(textarea, 'continue each answer');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(sendMultiModelMessage).toHaveBeenCalledWith({
      content: 'continue each answer',
      targetModels: [
        { providerId: 'provider-1', modelId: 'model-1' },
        { providerId: 'provider-2', modelId: 'model-1' },
      ],
      historyMode: 'per_model',
      attachments: undefined,
      searchProviderId: 'search-1',
    }));
  });

  it('keeps the draft when a selected companion model is unavailable', async () => {
    conversationState.multiModelTargets = [
      { providerId: 'provider-2', modelId: 'model-1' },
    ];
    providerState.providers[1].enabled = false;

    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await userEvent.type(textarea, 'preserve unavailable target draft');
    await userEvent.click(screen.getByLabelText('chat.sendMessage'));

    expect(textarea).toHaveValue('preserve unavailable target draft');
    expect(sendMultiModelMessage).not.toHaveBeenCalled();
    expect(screen.getAllByText('chat.multiModel.unavailableModel').length).toBeGreaterThan(0);
    fireEvent.change(textarea, { target: { value: '' } });
  });

  it('uses the stored follow-up mode when a welcome-card prompt is sent', async () => {
    conversationState.multiModelTargets = [
      { providerId: 'provider-1', modelId: 'model-1' },
      { providerId: 'provider-2', modelId: 'model-1' },
    ];
    conversationState.multiModelContinuationMode = 'per_model';

    const view = render(
      <App>
        <InputArea />
      </App>,
    );
    expect(await screen.findByTestId('multi-model-follow-up-mode')).toBeInTheDocument();

    conversationState.pendingPromptText = 'welcome follow-up';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );

    await waitFor(() => expect(sendMultiModelMessage).toHaveBeenCalledWith({
      content: 'welcome follow-up',
      targetModels: [
        { providerId: 'provider-1', modelId: 'model-1' },
        { providerId: 'provider-2', modelId: 'model-1' },
      ],
      historyMode: 'per_model',
      searchProviderId: 'search-1',
    }));
    expect(setPendingPromptText).toHaveBeenCalledWith(null);
  });

  it('submits a normal welcome-card prompt through the unified chat queue entrypoint', async () => {
    const view = render(
      <App>
        <InputArea />
      </App>,
    );

    conversationState.pendingPromptText = 'welcome prompt';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      'welcome prompt',
      undefined,
      'search-1',
    ));
    expect(setPendingPromptText).toHaveBeenCalledWith(null);
  });

  it('appends a rejected welcome-card prompt without overwriting the current draft', async () => {
    sendMessage.mockResolvedValueOnce({ kind: 'rejected', reason: 'conversation-loading' });
    const user = userEvent.setup();
    const view = render(
      <App>
        <InputArea />
      </App>,
    );
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    await user.type(textarea, 'existing draft');

    conversationState.pendingPromptText = 'welcome prompt';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      'welcome prompt',
      undefined,
      'search-1',
    ));
    await waitFor(() => expect(textarea).toHaveValue('existing draft\nwelcome prompt'));
    conversationState.pendingPromptText = null;
    fireEvent.change(textarea, { target: { value: '' } });
  });

  it('lets each companion model override the unified thinking level', async () => {
    providerState.providers[0].models[0].capabilities = ['Reasoning'];
    providerState.providers[1].models[0].capabilities = ['Reasoning'];
    conversationState.thinkingLevel = 'high';
    conversationState.multiModelTargets = [
      { providerId: 'provider-1', modelId: 'model-1' },
      { providerId: 'provider-2', modelId: 'model-1' },
    ];

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(screen.getByTestId('companion-thinking-0'));
    expect(await screen.findByText('Follow unified')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Low'));

    expect(conversationState.multiModelTargets).toEqual([
      { providerId: 'provider-1', modelId: 'model-1', thinkingLevel: 'low' },
      { providerId: 'provider-2', modelId: 'model-1' },
    ]);
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

  it('selects max reasoning for GPT-5.6 models', async () => {
    providerState.providers[0].provider_type = 'openai';
    providerState.providers[0].models[0].model_id = 'gpt-5.6-sol';
    providerState.providers[0].models[0].name = 'GPT-5.6 Sol';
    providerState.providers[0].models[0].capabilities = ['Reasoning'];
    conversationState.conversations[0].model_id = 'gpt-5.6-sol';

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(screen.getByLabelText('chat.thinkingIntensity'));
    await userEvent.click(await screen.findByText('Max'));

    expect(setThinkingLevel).toHaveBeenCalledWith('max');
  });

  it('uses the backend dynamic input budget for context usage', async () => {
    getContextUsage.mockResolvedValueOnce({
      used_tokens: 720000,
      context_window: 1000000,
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
    await userEvent.click(await screen.findByLabelText('上下文 tokens'));

    expect(await screen.findByText('720,000 / 700,000 tokens (100%)')).toBeInTheDocument();
  });

  it('shows strategy-aware token usage and excluded raw messages', async () => {
    getContextUsage.mockResolvedValueOnce({
      used_tokens: 80,
      context_window: 100,
      threshold_tokens: 70,
      has_summary: false,
      compressed_until_message_id: null,
      messages_after_boundary: 1,
      effective_strategy: 'raw_truncate',
      raw_tokens: 140,
      sent_tokens: 80,
      excluded_message_count: 2,
      exclusion_reason: 'message_limit',
      overflow: false,
    });

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(await screen.findByLabelText('上下文 tokens'));

    expect(await screen.findByText('80 / 70 tokens (100%)')).toBeInTheDocument();
    expect(screen.getByText(/chat\.contextRawTokens: 140/)).toBeInTheDocument();
    expect(screen.getByText(/chat\.contextExcludedMessages/)).toHaveTextContent(
      'chat.contextExclusionReasonMessageLimit',
    );
    expect(screen.getByText(/chat\.contextExcludedMessages/)).not.toHaveTextContent('message_limit');
    expect(screen.getByRole('button', { name: 'chat.compressNow' })).toBeDisabled();
  });

  it('keeps strict usage visible when the model context window is unknown', async () => {
    getContextUsage.mockResolvedValueOnce({
      used_tokens: 0,
      context_window: null,
      threshold_tokens: null,
      has_summary: false,
      compressed_until_message_id: null,
      messages_after_boundary: 4,
      effective_strategy: 'raw_strict',
      raw_tokens: 140,
      sent_tokens: 0,
      excluded_message_count: 4,
      exclusion_reason: 'context_window_unknown',
      overflow: true,
    });

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(await screen.findByLabelText('上下文 tokens'));

    expect(await screen.findByText('chat.contextWindowUnknownStrict')).toBeInTheDocument();
    expect(screen.getByText(/chat\.contextExcludedMessages/)).toHaveTextContent(
      'chat.contextExclusionReasonContextWindowUnknown',
    );
    const clearButton = screen.getByRole('button', { name: 'chat.clearContextToContinue' });
    await userEvent.click(clearButton);
    expect(insertContextClear).toHaveBeenCalledTimes(1);
  });

  it('shows a strict block when the context budget metadata is unknown', async () => {
    getContextUsage.mockResolvedValueOnce({
      used_tokens: 0,
      context_window: null,
      threshold_tokens: null,
      has_summary: false,
      compressed_until_message_id: null,
      messages_after_boundary: 4,
      effective_strategy: 'raw_strict',
      raw_tokens: 500,
      sent_tokens: 0,
      excluded_message_count: 4,
      exclusion_reason: 'context_budget_unknown',
      overflow: true,
    });

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(await screen.findByLabelText('上下文 tokens'));

    expect(await screen.findByText('chat.contextBudgetUnknownStrict')).toBeInTheDocument();
    expect(screen.queryByText('chat.contextWindowUnknownStrict')).not.toBeInTheDocument();
    expect(screen.getByText(/chat\.contextExcludedMessages/)).toHaveTextContent(
      'chat.contextExclusionReasonContextBudgetUnknown',
    );
    expect(screen.getByRole('button', { name: 'chat.clearContextToContinue' })).toBeInTheDocument();
  });

  it('falls back to a strict window-unknown state for legacy usage without a reason', async () => {
    getContextUsage.mockResolvedValueOnce({
      used_tokens: 0,
      context_window: null,
      threshold_tokens: null,
      has_summary: false,
      compressed_until_message_id: null,
      messages_after_boundary: 4,
      effective_strategy: 'raw_strict',
      raw_tokens: 140,
      sent_tokens: 0,
      excluded_message_count: 0,
      exclusion_reason: null,
      overflow: true,
    });

    render(
      <App>
        <InputArea />
      </App>,
    );

    await userEvent.click(await screen.findByLabelText('上下文 tokens'));

    expect(await screen.findByText('chat.contextWindowUnknownStrict')).toBeInTheDocument();
    expect(screen.queryByText('chat.contextBudgetUnknownStrict')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'chat.clearContextToContinue' })).toBeInTheDocument();
  });

  it('does not refetch context usage while a conversation switch is still loading messages', async () => {
    vi.useFakeTimers();
    try {
      conversationState.loading = true;
      conversationState.messages = [];
      getContextUsage.mockResolvedValue({
        used_tokens: 12,
        context_window: 100,
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

  it('lets the drop overlay pass through pointer events so the drop stays on the composer', () => {
    providerState.providers[0].models[0].capabilities = ['Vision'];

    render(
      <App>
        <InputArea />
      </App>,
    );

    const composer = document.querySelector('.px-4.pb-3.pt-1');
    expect(composer).toBeTruthy();
    fireEvent.dragEnter(composer as HTMLElement, {
      dataTransfer: { types: ['Files'], files: [] },
    });

    const label = screen.getByText('chat.dropToAttach');
    const overlay = label.parentElement?.parentElement;
    expect(overlay).toHaveStyle({ pointerEvents: 'none' });
  });

  it('shows image attachment controls when image input and document reading are not configured', () => {
    render(
      <App>
        <InputArea />
      </App>,
    );

    expect(screen.getByLabelText('chat.attachFile')).toBeInTheDocument();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input?.accept).toContain('image/*');
  });

  it('prompts to configure image input after selecting an image and opens the current provider', async () => {
    const user = userEvent.setup();
    render(
      <App>
        <InputArea />
      </App>,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(['image'], 'photo.png', { type: 'image/png' })],
      },
    });

    expect(await screen.findAllByText('chat.imageInputNotConfiguredTitle')).not.toHaveLength(0);
    expect(screen.getAllByText('chat.imageInputNotConfiguredContent')).not.toHaveLength(0);

    fireEvent.change(input, {
      target: {
        files: [new File(['second image'], 'second-photo.png', { type: 'image/png' })],
      },
    });
    expect(screen.getAllByRole('button', {
      name: 'chat.imageInputOpenProviderSettings',
    })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'chat.imageInputOpenProviderSettings' }));

    expect(enterSettings).toHaveBeenCalledOnce();
    expect(setSettingsSection).toHaveBeenCalledWith('providers');
    expect(setSelectedProviderId).toHaveBeenCalledWith('provider-1');
  });

  it('prompts to configure image input after pasting an image', async () => {
    render(
      <App>
        <InputArea />
      </App>,
    );

    const image = new File(['image'], 'clipboard.png', { type: 'image/png' });
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => image }],
        getData: (type: string) => (type === 'text/plain' ? 'copied image URL' : ''),
      },
    });
    const preventDefault = vi.spyOn(pasteEvent, 'preventDefault');
    fireEvent(textarea, pasteEvent);

    expect(await screen.findAllByText('chat.imageInputNotConfiguredTitle')).not.toHaveLength(0);
    expect(screen.getAllByText('chat.imageInputNotConfiguredContent')).not.toHaveLength(0);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(textarea).toHaveValue('');
  });

  it('prompts to configure image input after dropping an image', async () => {
    render(
      <App>
        <InputArea />
      </App>,
    );

    const composer = document.querySelector('.px-4.pb-3.pt-1');
    expect(composer).toBeTruthy();
    const image = new File(['image'], 'dropped.png', { type: 'image/png' });
    const dataTransfer = {
      types: ['Files'],
      files: [image],
      items: [],
      dropEffect: 'none',
    };

    fireEvent.dragEnter(composer as HTMLElement, { dataTransfer });
    fireEvent.drop(composer as HTMLElement, { dataTransfer });

    expect(await screen.findAllByText('chat.imageInputNotConfiguredTitle')).not.toHaveLength(0);
    expect(screen.getAllByText('chat.imageInputNotConfiguredContent')).not.toHaveLength(0);
  });

  it('reports unsupported non-image files alongside the image input prompt', async () => {
    render(
      <App>
        <InputArea />
      </App>,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(['image'], 'photo.png', { type: 'image/png' }),
          new File(['archive'], 'bundle.zip', { type: 'application/zip' }),
        ],
      },
    });

    expect(await screen.findAllByText('chat.imageInputNotConfiguredTitle')).not.toHaveLength(0);
    expect(await screen.findByText('chat.attachmentTypeUnsupported')).toBeInTheDocument();
  });

  it('accepts configured image input without showing the configuration prompt', async () => {
    providerState.providers[0].models[0].capabilities = ['Vision'];
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:vision-image');
    try {
      render(
        <App>
          <InputArea />
        </App>,
      );

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, {
        target: {
          files: [new File(['image'], 'vision.png', { type: 'image/png' })],
        },
      });

      expect(await screen.findByText('vision.png')).toBeInTheDocument();
      expect(screen.queryByText('chat.imageInputNotConfiguredTitle')).not.toBeInTheDocument();
    } finally {
      createObjectURL.mockRestore();
    }
  });

  it('revokes cached attachments when an inactive conversation is deleted', async () => {
    providerState.providers[0].models[0].capabilities = ['Vision'];
    const conversationA = conversationState.conversations[0];
    const conversationB = { ...conversationA, id: 'conv-2', title: 'Conversation B' };
    conversationState.conversations = [conversationA, conversationB];
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:deleted-draft');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
    try {
      const view = render(
        <App>
          <InputArea />
        </App>,
      );
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, new File(['image'], 'deleted.png', { type: 'image/png' }));
      expect(await screen.findByText('deleted.png')).toBeInTheDocument();

      conversationState.activeConversationId = 'conv-2';
      view.rerender(
        <App>
          <InputArea />
        </App>,
      );
      await waitFor(() => expect(screen.queryByText('deleted.png')).not.toBeInTheDocument());
      expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:deleted-draft');

      conversationState.conversations = [conversationB];
      view.rerender(
        <App>
          <InputArea />
        </App>,
      );
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:deleted-draft'));
    } finally {
      conversationState.conversations = [conversationA];
      conversationState.activeConversationId = 'conv-1';
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it('uses an enabled fallback provider when the configured default provider is disabled', async () => {
    const user = userEvent.setup();
    conversationState.activeConversationId = null;
    settingsState.settings.default_provider_id = 'provider-1';
    settingsState.settings.default_model_id = 'model-1';
    providerState.providers[0].enabled = false;
    providerState.providers.push({
      id: 'provider-2',
      provider_type: 'openai',
      enabled: true,
      models: [{
        provider_id: 'provider-2',
        model_id: 'model-2',
        name: 'model-2',
        model_type: 'Chat',
        enabled: true,
        capabilities: [],
        context_window: 128000,
        param_overrides: null,
      }],
    });
    render(
      <App>
        <InputArea />
      </App>,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(['image'], 'photo.png', { type: 'image/png' })],
      },
    });
    await user.click(await screen.findByRole('button', {
      name: 'chat.imageInputOpenProviderSettings',
    }));

    expect(setSelectedProviderId).toHaveBeenCalledWith('provider-2');
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
    expect(input?.accept).toContain('.txt');
    expect(input?.accept).toContain('.md');
  });

  it('preserves text and attachments when attachment conversion fails', async () => {
    settingsState.settings.document_attachment_reading_enabled = true;
    const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL')
      .mockImplementation(function failRead(this: FileReader) {
        Object.defineProperty(this, 'error', {
          configurable: true,
          value: new Error('attachment read failed'),
        });
        this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
      });

    render(
      <App>
        <InputArea />
      </App>,
    );

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    await user.type(textarea, 'keep attachment draft');
    await user.click(screen.getByLabelText('chat.sendMessage'));

    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    expect(textarea).toHaveValue('keep attachment draft');
    expect(sendMessage).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: '' } });
    readSpy.mockRestore();
  });

  it('collapses long pasted text into a snippet chip, inserts an inline token, and merges it on send', async () => {
    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    const longText = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n');

    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === 'text/plain' ? longText : ''),
      },
    });
    const preventDefault = vi.spyOn(pasteEvent, 'preventDefault');
    fireEvent(textarea, pasteEvent);

    expect(preventDefault).toHaveBeenCalled();
    expect(textarea).toHaveValue('[[paste:#1]]');
    expect(screen.getByText(/Pasted text #1 · 45 lines/)).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'Please summarize\n[[paste:#1]]' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalled();
    });

    const [content] = sendMessage.mock.calls[0];
    expect(content).toContain('Please summarize');
    expect(content).toContain('[Pasted text #1 · 45 lines]');
    expect(content).toContain('line 1');
    expect(content).toContain('line 45');
    expect(content.indexOf('Please summarize')).toBeLessThan(content.indexOf('line 1'));
  });

  it('expands inline tokens in the order they appear in the textarea', async () => {
    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    const longA = Array.from({ length: 45 }, (_, i) => `A${i + 1}`).join('\n');
    const longB = Array.from({ length: 45 }, (_, i) => `B${i + 1}`).join('\n');

    fireEvent(
      textarea,
      createEvent.paste(textarea, {
        clipboardData: {
          items: [],
          getData: (type: string) => (type === 'text/plain' ? longA : ''),
        },
      }),
    );
    fireEvent(
      textarea,
      createEvent.paste(textarea, {
        clipboardData: {
          items: [],
          getData: (type: string) => (type === 'text/plain' ? longB : ''),
        },
      }),
    );

    // Reverse token order relative to paste sequence so #2 appears before #1.
    fireEvent.change(textarea, {
      target: { value: `First\n[[paste:#2]]\nThen\n[[paste:#1]]` },
    });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalled();
    });

    const [content] = sendMessage.mock.calls[0];
    expect(content.indexOf('B1')).toBeLessThan(content.indexOf('A1'));
  });

  it('does not intercept short text paste', () => {
    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === 'text/plain' ? 'hello short' : ''),
      },
    });
    const preventDefault = vi.spyOn(pasteEvent, 'preventDefault');
    fireEvent(textarea, pasteEvent);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByText(/Pasted text #/)).not.toBeInTheDocument();
  });

  it('removes the inline token when a pasted snippet chip is deleted', async () => {
    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    const longText = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n');
    fireEvent(
      textarea,
      createEvent.paste(textarea, {
        clipboardData: {
          items: [],
          getData: (type: string) => (type === 'text/plain' ? longText : ''),
        },
      }),
    );

    fireEvent.change(textarea, { target: { value: `keep\n[[paste:#1]]\nme` } });
    await userEvent.click(screen.getByRole('button', { name: 'chat.removePastedText' }));

    expect(screen.queryByText(/Pasted text #1/)).not.toBeInTheDocument();
    expect(textarea.value).toBe('keep\nme');
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

  function pastePlainText(textarea: HTMLElement, text: string) {
    fireEvent(
      textarea,
      createEvent.paste(textarea, {
        clipboardData: {
          items: [],
          getData: (type: string) => (type === 'text/plain' ? text : ''),
        },
      }),
    );
  }

  it('sends a 61,440-byte pasted payload and an oversized snippet in full', async () => {
    const ascii60KiB = `${'a'.repeat(61_440 - 8)}TAIL-END`;
    expect(new TextEncoder().encode(ascii60KiB).byteLength).toBe(61_440);
    const oversized = `${'b'.repeat(96_001)}TAIL-END`;

    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '' } });
    pastePlainText(textarea, ascii60KiB);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalled();
    });
    const [firstContent] = sendMessage.mock.calls[0];
    expect(firstContent).toContain(ascii60KiB);
    expect(firstContent).toContain('TAIL-END');
    expect(textarea).toHaveValue('');
    expect(screen.queryByText(/Pasted text #1/)).not.toBeInTheDocument();

    sendMessage.mockClear();
    pastePlainText(textarea, oversized);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalled();
    });
    const [secondContent] = sendMessage.mock.calls[0];
    expect(secondContent).toContain(oversized);
    expect(secondContent).toContain('TAIL-END');
    expect(secondContent).not.toContain('[Pasted text truncated for model context budget.]');
    expect(textarea).toHaveValue('');
  });

  it('preserves the pasted draft and chip when unified submit rejects', async () => {
    conversationState.error = 'raw_strict context exceeds input budget';
    sendMessage.mockResolvedValueOnce({ kind: 'rejected', reason: 'invalid-message' });
    const oversized = `${'c'.repeat(96_001)}TAIL-END`;

    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '' } });
    pastePlainText(textarea, oversized);
    expect(textarea).toHaveValue('[[paste:#1]]');
    expect(screen.getByText(/Pasted text #1/)).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalled();
    });
    expect(sendMessage.mock.calls[0][0]).toContain(oversized);
    await waitFor(() => {
      expect(textarea).toHaveValue('[[paste:#1]]');
    });
    expect(screen.getByText(/Pasted text #1/)).toBeInTheDocument();
    expect(await screen.findByText('raw_strict context exceeds input budget')).toBeInTheDocument();
  });

  it('shows common.failed when unified submit rejects without a store error', async () => {
    conversationState.error = null;
    sendMessage.mockResolvedValueOnce({ kind: 'rejected', reason: 'invalid-message' });
    const longText = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n');

    render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '' } });
    pastePlainText(textarea, longText);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(textarea).toHaveValue('[[paste:#1]]');
    });
    expect(await screen.findByText('common.failed')).toBeInTheDocument();
  });

  function enableFunctionCalling() {
    providerState.providers[0].models[0].capabilities = ['FunctionCalling'];
  }

  function seedMcpServer() {
    mcpState.servers = [{
      id: 'mcp-fetch',
      name: '@aqbot/fetch',
      transport: 'stdio',
      enabled: true,
      permissionPolicy: 'ask',
      source: 'builtin',
    }];
    conversationState.enabledMcpServerIds = ['mcp-fetch'];
  }

  it('shows a terminal hint in the Chat MCP panel that is not an MCP server', async () => {
    const user = userEvent.setup();
    enableFunctionCalling();
    seedMcpServer();

    render(
      <App>
        <InputArea />
      </App>,
    );

    await user.click(screen.getByRole('button', { name: 'chat.mcp.title' }));
    expect(await screen.findByText('chat.mcp.terminalHint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'chat.mcp.switchToAgent' })).toBeInTheDocument();
    expect(screen.getByText('@aqbot/fetch')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'chat.mcp.terminalHint' })).not.toBeInTheDocument();
  });

  it('switches to Agent from the MCP terminal hint, initializes the workspace, and keeps the draft', async () => {
    const user = userEvent.setup();
    enableFunctionCalling();
    seedMcpServer();
    settingsState.settings.document_attachment_reading_enabled = true;

    const view = render(
      <App>
        <InputArea />
      </App>,
    );

    const textarea = screen.getByPlaceholderText('chat.inputPlaceholder') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'curl POST later' } });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'chat.mcp.title' }));
    await user.click(await screen.findByRole('button', { name: 'chat.mcp.switchToAgent' }));

    await waitFor(() => {
      expect(updateConversation).toHaveBeenCalledWith('conv-1', { mode: 'agent' });
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('agent_update_session', { conversationId: 'conv-1' });
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('agent_ensure_workspace', { conversationId: 'conv-1' });
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();

    conversationState.conversations[0].mode = 'agent';
    view.rerender(
      <App>
        <InputArea />
      </App>,
    );

    expect(screen.getByPlaceholderText('chat.inputPlaceholder')).toHaveValue('curl POST later');
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'chat.mcp.title' })).not.toBeInTheDocument();
    expect(conversationState.enabledMcpServerIds).toEqual(['mcp-fetch']);
  });

  it('hides the MCP selector in Agent mode and describes terminal capabilities on the mode entry', async () => {
    const user = userEvent.setup();
    enableFunctionCalling();
    seedMcpServer();
    conversationState.conversations[0].mode = 'agent';

    render(
      <App>
        <InputArea />
      </App>,
    );

    expect(screen.queryByRole('button', { name: 'chat.mcp.title' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /common.agentMode/ }));
    expect(await screen.findByText('common.agentModeCapabilities')).toBeInTheDocument();
  });
});
