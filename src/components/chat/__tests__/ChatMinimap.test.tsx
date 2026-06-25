import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatMinimap } from '../ChatMinimap';
import { useConversationStore, useSettingsStore } from '@/stores';
import type { Message, MessageSummary } from '@/types';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  isTauri: () => false,
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@lobehub/icons', () => {
  const Icon = () => <span data-testid="lobe-icon" />;
  return {
    ModelIcon: Icon,
    ProviderIcon: Icon,
    modelMappings: [],
    providerMappings: [],
    Claude: Icon,
    ClaudeCode: Icon,
    Codex: Icon,
    OpenCode: Icon,
    Gemini: Icon,
    Cursor: Icon,
  };
});

function makeMessage(index: number, role: Message['role']): Message {
  return {
    id: `msg-${index}`,
    conversation_id: 'conv-1',
    role,
    content: role === 'user' ? `question ${index}` : `answer ${index}`,
    provider_id: null,
    model_id: null,
    token_count: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: index,
    parent_message_id: role === 'assistant' ? `msg-${index - 1}` : null,
    version_index: 0,
    is_active: true,
    status: 'complete',
  };
}

function makeSummary(index: number, role: MessageSummary['role']): MessageSummary {
  return {
    id: `msg-${index}`,
    role,
    content_preview: role === 'user' ? `question ${index}` : `answer ${index}`,
    provider_id: null,
    model_id: null,
    created_at: index,
    parent_message_id: role === 'assistant' ? `msg-${index - 1}` : null,
  };
}

function makeSummaries(count: number, role: MessageSummary['role'] = 'user'): MessageSummary[] {
  return Array.from({ length: count }, (_, index) => makeSummary(index + 1, role));
}

describe('ChatMinimap', () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue([]);
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: [],
      hasOlderMessages: true,
      loadingOlder: false,
      loadOlderMessages: vi.fn(),
    });
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        chat_minimap_enabled: false,
        chat_minimap_style: 'faq',
      },
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not load older messages when chat navigation is disabled', () => {
    render(<ChatMinimap />);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useConversationStore.getState().loadOlderMessages).not.toHaveBeenCalled();
  });

  it('loads the full minimap from lightweight summaries instead of older message pages', async () => {
    invokeMock.mockResolvedValue([
      makeSummary(1, 'user'),
      makeSummary(2, 'assistant'),
      makeSummary(3, 'user'),
      makeSummary(4, 'assistant'),
    ]);
    useConversationStore.setState({
      messages: [makeMessage(3, 'user'), makeMessage(4, 'assistant')],
      hasOlderMessages: true,
    });
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        chat_minimap_enabled: true,
        chat_minimap_style: 'sticky',
      },
    }));

    render(<ChatMinimap />);

    await waitFor(() => expect(screen.getByText('4 / 4')).toBeInTheDocument());
    fireEvent.click(screen.getByText('4 / 4'));

    expect(screen.getByText('question 1')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('list_message_summaries', { conversationId: 'conv-1' });
    expect(useConversationStore.getState().loadOlderMessages).not.toHaveBeenCalled();
  });

  it('renders navigation from the currently loaded messages', () => {
    useConversationStore.setState({
      messages: [makeMessage(1, 'user'), makeMessage(2, 'assistant')],
      hasOlderMessages: true,
    });
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        chat_minimap_enabled: true,
        chat_minimap_style: 'sticky',
      },
    }));

    render(<ChatMinimap />);

    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByText('answer 2')).toBeInTheDocument();
    expect(useConversationStore.getState().loadOlderMessages).not.toHaveBeenCalled();
  });

  it('does not render every sticky dropdown summary at once', async () => {
    invokeMock.mockResolvedValue(makeSummaries(120, 'user'));
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        chat_minimap_enabled: true,
        chat_minimap_style: 'sticky',
      },
    }));

    render(<ChatMinimap />);

    await waitFor(() => expect(screen.getByText('120 / 120')).toBeInTheDocument());
    fireEvent.click(screen.getByText('120 / 120'));

    expect(screen.getByText('question 1')).toBeInTheDocument();
    expect(screen.queryByText('question 80')).not.toBeInTheDocument();
  });

  it('does not render every faq minimap dot at once', async () => {
    invokeMock.mockResolvedValue(makeSummaries(120, 'assistant'));
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        chat_minimap_enabled: true,
        chat_minimap_style: 'faq',
      },
    }));

    render(<ChatMinimap />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());

    expect(screen.queryByText('120')).not.toBeInTheDocument();
  });
});
