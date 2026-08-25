import { App } from 'antd';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type { Message, MultiModelDisplayMode } from '@/types';
import { ChatChromeContext } from '@/lib/chatChrome';
import { getMessageVersionGroupResourceKey } from '@/stores/conversationStoreSupport';
import { useAgentStore, useConversationStore, useSettingsStore } from '@/stores';
import { ChatView } from '../ChatView';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('markstream-react', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: ({ model }: { model: string }) => <span data-testid="lane-model-icon">{model}</span>,
}));

vi.mock('@/lib/convIcon', () => ({ getConvIcon: () => null }));
vi.mock('../InputArea', () => ({
  InputArea: () => <div data-testid="shared-input-area" />,
}));
vi.mock('../ModelSelector', () => ({ ModelSelector: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock('../MessageAttachmentPreview', () => ({ MessageAttachmentPreview: () => null }));
vi.mock('../ChatMinimap', () => ({
  ChatMinimap: () => <div data-testid="chat-minimap" />,
  MinimapScrollProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../ChatScrollIndicator', () => ({ ChatScrollIndicator: () => <div data-testid="chat-scroll-indicator" /> }));
vi.mock('../CodeBlockPreviewModal', () => ({ CodeBlockPreviewModal: () => null }));
vi.mock('../AskUserCard', () => ({ default: () => null }));
vi.mock('../PermissionCard', () => ({ default: () => null }));
vi.mock('../ConversationModelIcon', () => ({ ConversationModelIcon: () => null }));
vi.mock('../chatMarkdownShared', () => ({
  getChatCodeThemes: () => ({ darkTheme: 'dark', lightTheme: 'light', themes: {} }),
  setCodeBlockPreviewHandler: vi.fn(),
  setMermaidOpenModalHandler: vi.fn(),
}));
vi.mock('../ChatAssistantMarkdown', () => ({
  AssistantMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
  MessageRenderFallback: ({ content }: { content: string }) => <div>{content}</div>,
  PlainTextChatContent: ({ content }: { content: string }) => <div>{content}</div>,
  StreamingAssistantContent: ({
    baseContent,
    children,
  }: {
    baseContent: string;
    children: (content: string) => React.ReactNode;
  }) => <>{children(baseContent)}</>,
  MINIMAP_JUMP_AFTER_LIMIT: 10,
  MINIMAP_JUMP_BEFORE_LIMIT: 10,
  USER_SCROLL_INTENT_GRACE_MS: 500,
  shouldDeferAssistantMarkdownParse: () => false,
  stripAssistantAqbotTags: (content: string) => content,
  stripUserAqbotTags: (content: string) => content,
}));

vi.mock('../MultiModelDisplay', () => ({
  MultiModelDisplay: ({ versions }: { versions: Message[] }) => (
    <div data-testid={`multi-model-content-${versions[0]?.parent_message_id}`} />
  ),
  LayoutSwitcher: () => <div data-testid="layout-switcher" />,
}));

vi.mock('../ChatAssistantFooter', () => ({
  AssistantFooter: ({
    msg,
    displayMode,
  }: {
    msg: Message;
    displayMode?: MultiModelDisplayMode;
  }) => (
    displayMode
      ? <div data-testid={`layout-${msg.parent_message_id}`}>{displayMode}</div>
      : <div data-testid={`lane-footer-${msg.id}`} />
  ),
  StatsPopoverContent: () => null,
  findLatestLocalGeneratedVersion: () => null,
}));

function makeMessage(overrides: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    id: overrides.id,
    conversation_id: 'conv-1',
    role: overrides.role,
    content: overrides.content ?? overrides.id,
    provider_id: overrides.provider_id ?? null,
    model_id: overrides.model_id ?? null,
    token_count: null,
    prompt_tokens: null,
    completion_tokens: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: overrides.created_at ?? 1,
    parent_message_id: overrides.parent_message_id ?? null,
    version_index: overrides.version_index ?? 0,
    is_active: overrides.is_active ?? true,
    status: overrides.status ?? 'complete',
    tokens_per_second: null,
    first_token_latency_ms: null,
  };
}

describe('ChatView independent-window model columns', () => {
  beforeEach(() => {
    class TestIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds = [0];
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });

    const user = makeMessage({ id: 'user-1', role: 'user', content: 'compare these models' });
    const answerA = makeMessage({
      id: 'assistant-a',
      role: 'assistant',
      content: 'answer from model a',
      parent_message_id: 'user-1',
      provider_id: 'provider-a',
      model_id: 'model-a',
      is_active: true,
    });
    const answerB = makeMessage({
      id: 'assistant-b',
      role: 'assistant',
      content: 'answer from model b',
      parent_message_id: 'user-1',
      provider_id: 'provider-b',
      model_id: 'model-b',
      version_index: 1,
      is_active: false,
    });
    const versions = [answerA, answerB];

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [
        {
          id: 'conv-1',
          title: 'Conversation',
          provider_id: 'provider-a',
          model_id: 'model-a',
          multi_model_display_mode_override: 'tabs',
        } as never,
      ],
      messageVersionGroups: {
        [getMessageVersionGroupResourceKey('conv-1', 'user-1')]: {
          conversationId: 'conv-1',
          parentMessageId: 'user-1',
          versions,
          error: null,
          meta: { status: 'ready', key: 'user-1', loadedAt: 1, revision: 1 },
        },
      },
      messages: [user, answerA, answerB],
      loading: false,
      loadingOlder: false,
      loadingNewer: false,
      hasOlderMessages: false,
      hasNewerMessages: false,
      streaming: false,
      streamingMessageId: null,
      streamingConversationId: null,
      ragDisplayByMessageId: {},
      searchDisplayByMessageId: {},
      pendingCompanionModels: [],
      multiModelTargets: [{ providerId: 'provider-b', modelId: 'model-b' }],
      multiModelParentId: null,
      multiModelDoneMessageIds: [],
      thinkingActiveMessageIds: new Set(),
      error: null,
      listMessageVersionsBatch: vi.fn(async () => ({ 'user-1': versions })),
      ensureMessageVersionGroupsLoaded: vi.fn(async () => undefined),
      setConversationMultiModelDisplayMode: vi.fn(async () => undefined),
      updateConversation: vi.fn(async () => undefined),
    });
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, multi_model_display_mode: 'tabs' },
    }));
    useAgentStore.setState({ pendingPermissions: {}, toolCalls: {} });
  });

  it('shows one normal conversation column per model and a shared input', async () => {
    render(
      <App>
        <ChatChromeContext.Provider value={{ kind: 'popout' }}>
          <ChatView />
        </ChatChromeContext.Provider>
      </App>,
    );

    expect(await screen.findByTestId('multi-model-lane-workspace')).toBeInTheDocument();
    const columnA = screen.getByTestId('multi-model-lane-column-provider-a:model-a');
    const columnB = screen.getByTestId('multi-model-lane-column-provider-b:model-b');
    expect(screen.getAllByText('compare these models')).toHaveLength(2);
    await waitFor(() => {
      expect(within(columnA).getByText('answer from model a')).toBeInTheDocument();
      expect(within(columnB).getByText('answer from model b')).toBeInTheDocument();
    });
    expect(within(columnA).queryByText('answer from model b')).not.toBeInTheDocument();
    expect(within(columnB).queryByText('answer from model a')).not.toBeInTheDocument();
    expect(screen.getByTestId('shared-input-area')).toBeInTheDocument();
    expect(screen.queryByTestId('layout-user-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('layout-switcher')).not.toBeInTheDocument();
    expect(screen.queryByTestId('multi-model-content-user-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-minimap')).not.toBeInTheDocument();
  });
});
