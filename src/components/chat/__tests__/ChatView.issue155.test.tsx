import { App } from 'antd';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type { Message, MultiModelDisplayMode } from '@/types';
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

vi.mock('../MultiModelDisplay', () => ({
  MultiModelDisplay: ({ mode, versions }: { mode: string; versions: Message[] }) => (
    <div
      data-testid={`multi-model-content-${versions[0]?.parent_message_id}`}
      data-mode={mode}
      data-version-count={versions.length}
    />
  ),
}));

vi.mock('../ChatAssistantFooter', () => ({
  AssistantFooter: ({
    msg,
    displayMode,
    onDisplayModeChange,
  }: {
    msg: Message;
    displayMode?: string;
    onDisplayModeChange?: (parentMessageId: string, mode: MultiModelDisplayMode) => void;
  }) => (
    <button
      type="button"
      data-testid={`layout-${msg.parent_message_id}`}
      data-mode={displayMode}
      onClick={() => msg.parent_message_id && onDisplayModeChange?.(
        msg.parent_message_id,
        displayMode === 'side-by-side' ? 'stacked' : 'side-by-side',
      )}
    >
      {displayMode}
    </button>
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

function makeGroup(index: number): Message[] {
  const parentMessageId = `user-${index}`;
  return [
    makeMessage({ id: parentMessageId, role: 'user', created_at: index * 10 }),
    makeMessage({
      id: `assistant-${index}-a`,
      role: 'assistant',
      parent_message_id: parentMessageId,
      provider_id: 'provider-a',
      model_id: 'model-a',
      created_at: index * 10 + 1,
      is_active: true,
    }),
    makeMessage({
      id: `assistant-${index}-b`,
      role: 'assistant',
      parent_message_id: parentMessageId,
      provider_id: 'provider-b',
      model_id: 'model-b',
      created_at: index * 10 + 2,
      version_index: 1,
      is_active: false,
    }),
  ];
}

describe('ChatView issue #155 layout inheritance', () => {
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

    const initialMessages = makeGroup(1);
    const hydrateMessageVersions = useConversationStore.getState().hydrateMessageVersions;
    const versionsByParent = new Map<string, Message[]>();
    for (const message of [...makeGroup(1), ...makeGroup(2), ...makeGroup(3)]) {
      if (message.role === 'assistant' && message.parent_message_id) {
        const versions = versionsByParent.get(message.parent_message_id) ?? [];
        versions.push(message);
        versionsByParent.set(message.parent_message_id, versions);
      }
    }

    useConversationStore.setState({
      activeConversationId: 'conv-1',
      conversations: [
        {
          id: 'conv-1',
          title: 'Conversation',
          provider_id: 'provider-a',
          model_id: 'model-a',
          multi_model_display_mode_override: null,
        } as never,
        {
          id: 'conv-2',
          title: 'Other conversation',
          provider_id: 'provider-a',
          model_id: 'model-a',
          multi_model_display_mode_override: null,
        } as never,
      ],
      messageVersionGroups: {},
      messages: initialMessages,
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
      multiModelParentId: null,
      multiModelDoneMessageIds: [],
      thinkingActiveMessageIds: new Set(),
      error: null,
      hydrateMessageVersions,
      listMessageVersionsBatch: vi.fn(async (_conversationId: string, parentMessageIds: string[]) => (
        Object.fromEntries(parentMessageIds.map((parentId) => [parentId, versionsByParent.get(parentId) ?? []]))
      )),
      setConversationMultiModelDisplayMode: vi.fn(async (conversationId, mode) => {
        useConversationStore.setState((state) => ({
          conversations: state.conversations.map((conversation) => (
            conversation.id === conversationId
              ? { ...conversation, multi_model_display_mode_override: mode }
              : conversation
          )),
        }));
      }),
      updateConversation: vi.fn(async () => undefined),
    });
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, multi_model_display_mode: 'tabs' },
    }));
    useAgentStore.setState({ pendingPermissions: {}, toolCalls: {} });
  });

  it('uses the last selected layout for a new answer without changing earlier answer snapshots', async () => {
    render(<App><ChatView /></App>);

    const firstLayout = await screen.findByTestId('layout-user-1');
    expect(firstLayout).toHaveAttribute('data-mode', 'tabs');

    fireEvent.click(firstLayout);
    await waitFor(() => {
      expect(screen.getByTestId('layout-user-1')).toHaveAttribute('data-mode', 'side-by-side');
    });

    act(() => {
      useConversationStore.setState({
        messages: [...useConversationStore.getState().messages, ...makeGroup(2)],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('layout-user-1')).toHaveAttribute('data-mode', 'side-by-side');
      expect(screen.getByTestId('layout-user-2')).toHaveAttribute('data-mode', 'side-by-side');
      expect(screen.getByTestId('multi-model-content-user-1')).toHaveAttribute('data-version-count', '2');
    });

    fireEvent.click(screen.getByTestId('layout-user-2'));
    await waitFor(() => {
      expect(screen.getByTestId('layout-user-1')).toHaveAttribute('data-mode', 'side-by-side');
      expect(screen.getByTestId('layout-user-2')).toHaveAttribute('data-mode', 'stacked');
    });

    act(() => {
      useConversationStore.setState({
        messages: [...useConversationStore.getState().messages, ...makeGroup(3)],
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('layout-user-3')).toHaveAttribute('data-mode', 'stacked');
    });

    act(() => {
      useConversationStore.setState({ activeConversationId: 'conv-2', messages: [] });
    });
    act(() => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: [...makeGroup(1), ...makeGroup(2), ...makeGroup(3)],
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('layout-user-1')).toHaveAttribute('data-mode', 'stacked');
      expect(screen.getByTestId('layout-user-2')).toHaveAttribute('data-mode', 'stacked');
      expect(screen.getByTestId('layout-user-3')).toHaveAttribute('data-mode', 'stacked');
    });
  });

  it('keeps the current answer layout but rolls back the next-answer default when persistence fails', async () => {
    useConversationStore.setState({
      setConversationMultiModelDisplayMode: vi.fn(async () => {
        throw new Error('save failed');
      }),
    });

    render(<App><ChatView /></App>);

    fireEvent.click(await screen.findByTestId('layout-user-1'));
    await waitFor(() => {
      expect(screen.getByTestId('layout-user-1')).toHaveAttribute('data-mode', 'side-by-side');
      expect(screen.getByText('chat.multiModel.displayModeSaveFailed')).toBeInTheDocument();
    });

    act(() => {
      useConversationStore.setState({
        messages: [...useConversationStore.getState().messages, ...makeGroup(2)],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('layout-user-1')).toHaveAttribute('data-mode', 'side-by-side');
      expect(screen.getByTestId('layout-user-2')).toHaveAttribute('data-mode', 'tabs');
    });
  });
});
