import { App } from 'antd';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
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

function renderDisplay(versions: Message[]) {
  return (
    <App>
      <MultiModelDisplay
        versions={versions}
        activeMessageId={versions[0]?.id ?? ''}
        mode="side-by-side"
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

describe('MultiModelDisplay', () => {
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
});
