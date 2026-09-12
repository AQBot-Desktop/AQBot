import { App } from 'antd';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Message } from '@/types';
import { useAgentStore, useConversationStore, useSettingsStore } from '@/stores';
import { setupAgentEventListeners } from '@/stores/agentStore';
import { deferred, makeConversation, makeMessage, makePage } from '@/stores/__tests__/conversationStore.testUtils';
import { ChatView } from '../ChatView';

const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  isTauri: () => true,
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    const callbacks = listeners.get(name) ?? new Set();
    callbacks.add(listener);
    listeners.set(name, callbacks);
    return () => { callbacks.delete(listener); };
  }),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('markstream-react', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
  setCustomComponents: vi.fn(),
  withMarkstreamComponentDisplay: (component: unknown) => component,
}));
vi.mock('@lobehub/icons', () => ({ ModelIcon: () => null }));
vi.mock('@/lib/convIcon', () => ({ getConvIcon: () => null }));
vi.mock('../InputArea', () => ({ InputArea: () => null }));
vi.mock('../ModelSelector', () => ({ ModelSelector: ({ children }: { children?: ReactNode }) => <>{children}</> }));
vi.mock('../MessageAttachmentPreview', () => ({ MessageAttachmentPreview: () => null }));
vi.mock('../ChatMinimap', () => ({
  ChatMinimap: () => null,
  MinimapScrollProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../ChatScrollIndicator', () => ({ ChatScrollIndicator: () => null }));
vi.mock('../CodeBlockPreviewModal', () => ({ CodeBlockPreviewModal: () => null }));
vi.mock('../ConversationModelIcon', () => ({ ConversationModelIcon: () => null }));
vi.mock('../chatMarkdownShared', () => ({
  getChatCodeThemes: () => ({ darkTheme: 'dark', lightTheme: 'light', themes: {} }),
  setCodeBlockPreviewHandler: vi.fn(), setMermaidOpenModalHandler: vi.fn(),
  ThinkNode: () => null,
}));
// Keep the real live-content subscription; only replace the expensive markdown renderer.
vi.mock('../ChatAssistantMarkdown', async importOriginal => ({
  ...await importOriginal<typeof import('../ChatAssistantMarkdown')>(),
  AssistantMarkdown: ({ content }: { content: string }) => <div data-testid="answer-content">{content}</div>,
}));
vi.mock('../ChatAssistantFooter', () => ({
  AssistantFooter: () => null, StatsPopoverContent: () => null,
  findLatestLocalGeneratedVersion: () => null,
}));

function emit(name: string, payload: unknown) {
  for (const listener of listeners.get(name) ?? []) listener({ payload });
}

let persistedMessages: Message[] = [];
let stopAgentListeners: () => void;

describe('issue 200 agent reply visibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    listeners.clear();
    persistedMessages = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
      unobserve() {}
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useConversationStore.setState({
      ...useConversationStore.getInitialState(),
      activeConversationId: 'conv-1',
      conversations: [makeConversation('conv-1', { mode: 'agent' }), makeConversation('conv-2')]
        .map(conversation => ({ ...conversation, multi_model_display_mode_override: null })),
    });
    useAgentStore.setState(useAgentStore.getInitialState());
    useSettingsStore.setState(state => ({ settings: { ...state.settings, multi_model_display_mode: 'tabs' } }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'agent_query' || command === 'agent_cancel') return;
      if (command === 'list_active_conversation_runs' || command === 'list_tool_executions') return [];
      if (command === 'get_multi_model_run_snapshot') return { conversationId: 'conv-1', revision: 0, activeRun: null };
      if (command === 'list_message_versions_batch') {
        return Object.fromEntries((args?.parentMessageIds as string[]).map(id => [id,
          persistedMessages.filter(message => message.parent_message_id === id),
        ]));
      }
      if (command === 'list_messages_page') {
        return makePage(persistedMessages.filter(message => message.conversation_id === args?.conversationId), false);
      }
      if (command === 'get_conversation_snapshot') {
        return makeConversation(String(args?.id), { mode: 'agent', message_count: 2, updated_at: 2 });
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });
    stopAgentListeners = setupAgentEventListeners();
  });

  afterEach(async () => {
    cleanup();
    const run = useConversationStore.getState().runsByConversation['conv-1'];
    if (run) {
      emit('chat-stream-terminal', {
        conversation_id: 'conv-1', message_id: run.streamingMessageId, stream_id: run.streamId,
        outcome: 'cancelled', error: null,
      });
    }
    stopAgentListeners();
    useConversationStore.getState().stopStreamListening();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function beginRun() {
    await useConversationStore.getState().sendAgentMessage('use skill');
    const run = useConversationStore.getState().runsByConversation['conv-1'];
    const user = { ...makeMessage(1), id: 'z-user', content: 'use skill', created_at: 1000 };
    const assistant = { ...makeMessage(2), id: 'a-assistant', parent_message_id: user.id,
      content: 'skill answer', status: 'partial' as const, created_at: 1000 };
    persistedMessages = [user, assistant];
    return { runId: run.runId, assistant, user };
  }

  function emitOutput(runId: string) {
    emit('agent-stream-thinking', { conversationId: 'conv-1', runId, thinking: 'inspect skill' });
    emit('agent-stream-text', { conversationId: 'conv-1', runId, text: 'skill answer' });
    emit('agent-permission-request', {
      conversationId: 'conv-1', assistantMessageId: 'a-assistant', runId,
      toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'pwd' }, riskLevel: 'execute',
    });
  }

  function expectVisibleReply() {
    expect(useConversationStore.getState().messages.find(message => message.id === 'a-assistant'))
      .toMatchObject({ content: expect.stringContaining('skill answer'), thinking: 'inspect skill' });
    expect(screen.getByTestId('answer-content')).toHaveTextContent('skill answer');
    expect(screen.getByTestId('answer-content')).toHaveTextContent('inspect skill');
    expect(screen.getByRole('button', { name: /common.allowOnce/ })).toBeVisible();
  }

  it.each(['before', 'after'] as const)('shows output and permission when the real ID arrives %s version loading', async timing => {
    const { runId } = await beginRun();
    const resolveId = () => emit('agent-message-id', {
      conversationId: 'conv-1', runId, assistantMessageId: 'a-assistant',
    });
    if (timing === 'before') resolveId();
    render(<App><ChatView /></App>);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    await act(async () => {
      if (timing === 'after') resolveId();
      emitOutput(runId);
      await vi.advanceTimersByTimeAsync(20);
    });
    expectVisibleReply();
    const queriedParents = invokeMock.mock.calls
      .filter(([command]) => command === 'list_message_versions_batch')
      .flatMap(([, args]) => args.parentMessageIds as string[]);
    expect(queriedParents.some(id => id.startsWith('temp-'))).toBe(false);
  });

  it('keeps a real-parent reply through a delayed snapshot, background navigation, and stopping', async () => {
    const { runId, user, assistant } = await beginRun();
    const snapshot = deferred<Record<string, Message[]>>();
    const originalInvoke = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command, args) => command === 'list_message_versions_batch'
      ? snapshot.promise : originalInvoke(command, args));
    emit('agent-message-id', { conversationId: 'conv-1', runId, assistantMessageId: assistant.id });
    useConversationStore.setState({ messages: [user, { ...assistant, content: '' }] });
    render(<App><ChatView /></App>);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(invokeMock).toHaveBeenCalledWith('list_message_versions_batch', {
      conversationId: 'conv-1', parentMessageIds: [user.id],
    });
    await act(async () => {
      snapshot.resolve({ [user.id]: [] });
      await vi.advanceTimersByTimeAsync(0);
      emitOutput(runId);
      await vi.advanceTimersByTimeAsync(20);
    });
    expectVisibleReply();
    invokeMock.mockImplementation(originalInvoke);
    await act(async () => { useConversationStore.getState().setActiveConversation('conv-2'); });
    await act(async () => {
      emit('agent-stream-text', { conversationId: 'conv-1', runId, text: ' continued' });
      await vi.advanceTimersByTimeAsync(20);
      useConversationStore.getState().setActiveConversation('conv-1');
      await vi.advanceTimersByTimeAsync(600);
    });
    expectVisibleReply();
    expect(screen.getByTestId('answer-content')).toHaveTextContent('continued');
    expect(useConversationStore.getState().messages.map(message => message.id)).toEqual([user.id, assistant.id]);
    await act(async () => {
      const stopped = useConversationStore.getState().cancelCurrentStream();
      await vi.advanceTimersByTimeAsync(0);
      emit('chat-stream-terminal', {
        conversation_id: 'conv-1', message_id: assistant.id, stream_id: runId, outcome: 'cancelled', error: null,
      });
      await stopped;
    });
    expect(useConversationStore.getState().streaming).toBe(false);
    expect(screen.getByTestId('answer-content')).toHaveTextContent('skill answer');
    expect(useConversationStore.getState().messages.map(message => message.id)).toEqual([user.id, assistant.id]);
  });
});
