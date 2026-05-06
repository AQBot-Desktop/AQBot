import { App } from 'antd';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import { useConversationStore } from '@/stores';
import { MultiModelDisplay } from '../MultiModelDisplay';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: ({ model }: { model: string }) => <span data-testid="model-icon">{model}</span>,
}));

vi.mock('overlayscrollbars', () => ({
  OverlayScrollbars: vi.fn(() => ({ destroy: vi.fn() })),
}));

function makeMessage(overrides: Partial<Message> & Pick<Message, 'id' | 'model_id' | 'content'>): Message {
  return {
    id: overrides.id,
    conversation_id: 'conv-1',
    role: 'assistant',
    content: overrides.content,
    provider_id: overrides.provider_id ?? 'provider-1',
    model_id: overrides.model_id,
    token_count: null,
    prompt_tokens: null,
    completion_tokens: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: overrides.created_at ?? 1,
    parent_message_id: overrides.parent_message_id ?? 'user-1',
    version_index: overrides.version_index ?? 0,
    is_active: overrides.is_active ?? true,
    status: overrides.status ?? 'complete',
    tokens_per_second: null,
    first_token_latency_ms: null,
  };
}

function renderDisplay(
  versions: Message[],
  activeMessageId = versions[0]?.id ?? '',
  mode: 'side-by-side' | 'stacked' = 'side-by-side',
) {
  return (
    <App>
      <MultiModelDisplay
        versions={versions}
        activeMessageId={activeMessageId}
        mode={mode}
        conversationId="conv-1"
        onSwitchVersion={vi.fn()}
        onDeleteVersion={vi.fn()}
        streamingMessageId={null}
        multiModelDoneMessageIds={[]}
        getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? '', providerName: '' })}
        renderContent={(message) => <div>{message.content}</div>}
      />
    </App>
  );
}

function renderDisplayWithStreamingLabel(versions: Message[], streamingMessageId: string | null) {
  return (
    <App>
      <MultiModelDisplay
        versions={versions}
        activeMessageId={versions[0]?.id ?? ''}
        mode="side-by-side"
        conversationId="conv-1"
        onSwitchVersion={vi.fn()}
        onDeleteVersion={vi.fn()}
        streamingMessageId={streamingMessageId}
        multiModelDoneMessageIds={[]}
        getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? '', providerName: '' })}
        renderContent={(message, isStreaming) => (
          <div data-testid={`content-${message.id}`}>
            {isStreaming ? 'streaming' : 'stable'}:{message.content}
          </div>
        )}
      />
    </App>
  );
}

describe('MultiModelDisplay', () => {
  beforeEach(() => {
    useConversationStore.setState({
      messages: [],
      activeConversationId: 'conv-1',
      streaming: false,
      streamingConversationId: null,
      streamingMessageId: null,
    });
  });

  it('does not fall back to the error boundary when deleting down to one model', () => {
    const modelA = makeMessage({ id: 'assistant-a', model_id: 'model-a', content: 'alpha' });
    const modelB = makeMessage({ id: 'assistant-b', model_id: 'model-b', content: 'beta', is_active: false, version_index: 1 });

    const { rerender } = render(renderDisplay([modelA, modelB]));

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();

    rerender(renderDisplay([modelA]));

    expect(screen.queryByText('Multi-model display error')).not.toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('updates an inactive streaming card from the store without rerendering the parent bubble item', () => {
    const modelA = makeMessage({ id: 'assistant-a', model_id: 'model-a', content: 'alpha' });
    const modelB = makeMessage({ id: 'assistant-b', model_id: 'model-b', content: '', is_active: false, status: 'partial', version_index: 1 });
    useConversationStore.setState({ messages: [modelA, modelB] });

    render(renderDisplay([modelA, modelB]));

    expect(screen.queryByText('streamed token')).not.toBeInTheDocument();

    act(() => {
      useConversationStore.setState({
        messages: [modelA, { ...modelB, content: 'streamed token' }],
      });
    });

    expect(screen.getByText('streamed token')).toBeInTheDocument();
  });

  it('shows the active same-model version in side-by-side mode', () => {
    const modelAOld = makeMessage({
      id: 'assistant-a-old',
      model_id: 'model-a',
      content: 'old same-model answer',
      is_active: true,
      version_index: 0,
      created_at: 1,
    });
    const modelALatest = makeMessage({
      id: 'assistant-a-latest',
      model_id: 'model-a',
      content: 'latest same-model answer',
      is_active: false,
      version_index: 1,
      created_at: 2,
    });
    const modelB = makeMessage({
      id: 'assistant-b',
      model_id: 'model-b',
      content: 'other model answer',
      is_active: false,
      version_index: 0,
      created_at: 3,
    });

    render(renderDisplay([modelAOld, modelALatest, modelB], modelAOld.id, 'side-by-side'));

    expect(screen.getByText('old same-model answer')).toBeInTheDocument();
    expect(screen.queryByText('latest same-model answer')).not.toBeInTheDocument();
    expect(screen.getByText('other model answer')).toBeInTheDocument();
  });

  it('shows the active same-model version in stacked mode', () => {
    const modelAOld = makeMessage({
      id: 'assistant-a-old',
      model_id: 'model-a',
      content: 'old stacked answer',
      is_active: true,
      version_index: 0,
      created_at: 1,
    });
    const modelALatest = makeMessage({
      id: 'assistant-a-latest',
      model_id: 'model-a',
      content: 'latest stacked answer',
      is_active: false,
      version_index: 1,
      created_at: 2,
    });
    const modelB = makeMessage({
      id: 'assistant-b',
      model_id: 'model-b',
      content: 'stacked other model answer',
      is_active: false,
      version_index: 0,
      created_at: 3,
    });

    render(renderDisplay([modelAOld, modelALatest, modelB], modelAOld.id, 'stacked'));

    expect(screen.getByText('old stacked answer')).toBeInTheDocument();
    expect(screen.queryByText('latest stacked answer')).not.toBeInTheDocument();
    expect(screen.getByText('stacked other model answer')).toBeInTheDocument();
  });

  it('treats partial cards as streaming while their conversation is streaming even without a matching streamingMessageId', () => {
    const modelA = makeMessage({ id: 'assistant-a', model_id: 'model-a', content: 'alpha' });
    const modelB = makeMessage({
      id: 'assistant-b',
      model_id: 'model-b',
      content: '```ts\nconst token = 1;',
      is_active: false,
      status: 'partial',
      version_index: 1,
    });
    useConversationStore.setState({
      messages: [modelA, modelB],
      streaming: true,
      streamingConversationId: 'conv-1',
      streamingMessageId: null,
    });

    render(renderDisplayWithStreamingLabel([modelA, modelB], null));

    expect(screen.getByTestId('content-assistant-b')).toHaveTextContent('streaming:```ts');
  });
});
