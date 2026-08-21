import { App } from 'antd';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import type { Message } from '@/types';
import { useConversationStore } from '@/stores';
import { AssistantFooter } from '../ChatAssistantFooter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: ({ model }: { model: string }) => <span data-model={model} data-testid="model-icon" />,
}));

vi.mock('@ant-design/x/es/actions', () => ({
  default: ({ items }: {
    items: Array<{
      key: string;
      actionRender?: () => React.ReactNode;
    }>;
  }) => (
    <div data-testid="assistant-actions">
      {items.map((item) => (
        <div data-action-key={item.key} key={item.key}>
          {item.actionRender?.() ?? <button type="button">{item.key}</button>}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({
    copy: vi.fn().mockResolvedValue(true),
    isCopied: false,
  }),
}));

vi.mock('@/components/layout/PageLifecycle', () => ({
  usePageSuspendCleanup: vi.fn(),
  usePageTransientOpenState: () => [false, vi.fn()],
}));

vi.mock('../ModelSelector', () => ({
  ModelSelector: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../MultiModelDisplay', () => ({
  LayoutSwitcher: () => <div data-testid="layout-switcher" />,
}));

vi.mock('../SaveToMemoryPopover', () => ({
  SaveToMemoryPopover: ({ content, children }: { content: string; children: React.ReactNode }) => (
    <div data-memory-content={content}>{children}</div>
  ),
}));

function makeMessage(): Message {
  return {
    id: 'assistant-1',
    conversation_id: 'conversation-1',
    role: 'assistant',
    content: 'raw assistant content',
    provider_id: 'provider-1',
    model_id: 'model-1',
    token_count: null,
    prompt_tokens: null,
    completion_tokens: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: 1,
    parent_message_id: 'user-1',
    version_index: 0,
    is_active: true,
    status: 'complete',
    tokens_per_second: null,
    first_token_latency_ms: null,
  };
}

describe('AssistantFooter memory action', () => {
  beforeEach(() => {
    const message = makeMessage();
    useConversationStore.setState({
      conversations: [{
        id: 'conversation-1',
        title: 'Conversation',
        provider_id: 'provider-1',
        model_id: 'model-1',
      } as never],
      messages: [message],
      pendingCompanionModels: [],
      multiModelParentId: null,
      multiModelDoneMessageIds: [],
    });
  });

  it('places save-memory after branch and passes the cleaned assistant text', () => {
    const message = makeMessage();
    const { container } = render(
      <App>
        <AssistantFooter
          assistantCopyText={'cleaned **answer**'}
          conversationId="conversation-1"
          getModelDisplayInfo={() => ({ modelName: 'Model', providerName: 'Provider' })}
          msg={message}
          onEditMessage={vi.fn()}
          versions={[message]}
        />
      </App>,
    );

    const keys = Array.from(container.querySelectorAll('[data-action-key]'))
      .map((node) => node.getAttribute('data-action-key'));

    expect(keys.indexOf('save-memory')).toBe(keys.indexOf('branch') + 1);
    expect(keys.indexOf('delete')).toBe(keys.indexOf('save-memory') + 1);
    expect(container.querySelector('[data-memory-content]'))
      .toHaveAttribute('data-memory-content', 'cleaned **answer**');
  });

  it('renders separate model tags for identical model ids from different providers', () => {
    const providerA = makeMessage();
    const providerB = {
      ...makeMessage(),
      id: 'assistant-2',
      provider_id: 'provider-2',
      is_active: false,
      version_index: 1,
    };

    render(
      <App>
        <AssistantFooter
          assistantCopyText="answer"
          conversationId="conversation-1"
          getModelDisplayInfo={() => ({ modelName: 'Model', providerName: 'Provider' })}
          msg={providerA}
          onEditMessage={vi.fn()}
          versions={[providerA, providerB]}
        />
      </App>,
    );

    expect(screen.getAllByTestId('model-icon')).toHaveLength(2);
  });

  it('shows and switches model progress while the first model is streaming', () => {
    const message = { ...makeMessage(), status: 'partial' as const };
    const companion = {
      ...message,
      id: 'assistant-2',
      provider_id: 'provider-2',
      model_id: 'model-2',
      is_active: false,
    };
    const switchMessageVersion = vi.fn().mockResolvedValue(undefined);
    useConversationStore.setState({
      messages: [message, companion],
      pendingCompanionModels: [
        { providerId: 'provider-1', modelId: 'model-1' },
        { providerId: 'provider-2', modelId: 'model-2' },
        { providerId: 'provider-3', modelId: 'model-3' },
      ],
      multiModelParentId: 'user-1',
      multiModelDoneMessageIds: [],
      switchMessageVersion,
    });

    render(
      <App>
        <AssistantFooter
          assistantCopyText=""
          conversationId="conversation-1"
          displayMode="tabs"
          getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? '', providerName: 'Provider' })}
          isStreaming
          msg={message}
          onDisplayModeChange={vi.fn()}
          onEditMessage={vi.fn()}
          versions={[message]}
        />
      </App>,
    );

    expect(screen.getAllByTestId('model-icon')).toHaveLength(3);
    expect(screen.getByTestId('layout-switcher')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-actions')).not.toBeInTheDocument();
    const companionIcon = screen.getAllByTestId('model-icon')
      .find((icon) => icon.getAttribute('data-model') === 'model-2');
    fireEvent.click(companionIcon!.parentElement!);
    expect(switchMessageVersion).toHaveBeenCalledWith('conversation-1', 'user-1', 'assistant-2');
  });
});
