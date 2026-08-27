import { App } from 'antd';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type { Message } from '@/types';
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
  ModelIcon: ({ model }: { model: string }) => <span data-testid="model-icon">{model}</span>,
}));

vi.mock('@/lib/convIcon', () => ({ getConvIcon: () => null }));
vi.mock('../InputArea', () => ({ InputArea: () => null }));
vi.mock('../ModelSelector', () => ({ ModelSelector: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock('../MessageAttachmentPreview', () => ({ MessageAttachmentPreview: () => null }));
vi.mock('../ChatMinimap', () => ({
  ChatMinimap: () => null,
  MinimapScrollProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../ChatScrollIndicator', () => ({ ChatScrollIndicator: () => null }));
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

vi.mock('../ChatAssistantFooter', () => ({
  AssistantFooter: () => null,
  StatsPopoverContent: () => null,
  findLatestLocalGeneratedVersion: () => null,
}));

function makeMessage(overrides: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    id: overrides.id,
    conversation_id: 'conv-1',
    role: overrides.role,
    content: overrides.content ?? '',
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

describe('ChatView remote multi-model stream', () => {
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

    const user = makeMessage({ id: 'user-1', role: 'user', content: 'hello' });
    const answerA = makeMessage({
      id: 'assistant-a',
      role: 'assistant',
      parent_message_id: 'user-1',
      provider_id: 'provider-a',
      model_id: 'model-a',
      status: 'partial',
      is_active: true,
    });
    const answerB = makeMessage({
      id: 'assistant-b',
      role: 'assistant',
      parent_message_id: 'user-1',
      provider_id: 'provider-b',
      model_id: 'model-b',
      version_index: 1,
      status: 'partial',
      is_active: false,
    });

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
          versions: [answerA, answerB],
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
      observedStream: null,
      ragDisplayByMessageId: {},
      searchDisplayByMessageId: {},
      pendingCompanionModels: [],
      multiModelTargets: [{ providerId: 'provider-b', modelId: 'model-b' }],
      multiModelParentId: null,
      multiModelDoneMessageIds: [],
      thinkingActiveMessageIds: new Set(),
      error: null,
      listMessageVersionsBatch: vi.fn(async () => ({ 'user-1': [answerA, answerB] })),
      ensureMessageVersionGroupsLoaded: vi.fn(async () => undefined),
      setConversationMultiModelDisplayMode: vi.fn(async () => undefined),
      updateConversation: vi.fn(async () => undefined),
    });
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, multi_model_display_mode: 'tabs' },
    }));
    useAgentStore.setState({ pendingPermissions: {}, toolCalls: {} });
  });

  it('shows a stopped tag when a partial reply is not streaming anywhere', () => {
    render(<App><ChatView /></App>);
    expect(screen.getByText('chat.partial')).toBeInTheDocument();
    expect(document.querySelector('.aqbot-streaming-dots')).toBeNull();
  });

  it('shows live loading instead of stopped when another window is still streaming', () => {
    useConversationStore.setState({
      observedStream: {
        conversationId: 'conv-1',
        streaming: true,
        streamId: 'stream-a',
        streamingMessageId: 'assistant-a',
        multiModelParentId: 'user-1',
        pendingCompanionModels: [
          { providerId: 'provider-a', modelId: 'model-a' },
          { providerId: 'provider-b', modelId: 'model-b' },
        ],
        multiModelDoneMessageIds: [],
      },
    });

    render(<App><ChatView /></App>);

    expect(screen.queryByText('chat.partial')).not.toBeInTheDocument();
    expect(document.querySelector('.aqbot-streaming-dots')).not.toBeNull();
  });
});
