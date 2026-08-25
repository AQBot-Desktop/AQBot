import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import { MultiModelLaneWorkspace } from '../MultiModelLaneWorkspace';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'assistant',
    content: '',
    provider_id: 'provider-a',
    model_id: 'model-a',
    token_count: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: 1,
    parent_message_id: 'user-1',
    version_index: 0,
    is_active: true,
    status: 'complete',
    ...overrides,
  };
}

describe('MultiModelLaneWorkspace', () => {
  it('projects the same user question into each model column', () => {
    const user = makeMessage({
      id: 'user-1',
      role: 'user',
      content: 'compare these models',
      parent_message_id: null,
      model_id: null,
      provider_id: null,
    });
    const answerA = makeMessage({
      id: 'a',
      content: 'answer A',
      provider_id: 'provider-a',
      model_id: 'model-a',
      version_index: 0,
    });
    const answerB = makeMessage({
      id: 'b',
      content: 'answer B',
      provider_id: 'provider-b',
      model_id: 'model-b',
      version_index: 1,
      is_active: false,
    });

    render(
      <MultiModelLaneWorkspace
        userMessages={[user]}
        versionsByParentId={{ 'user-1': [answerA, answerB] }}
        columns={[
          { key: 'provider-a:model-a', providerId: 'provider-a', modelId: 'model-a', historical: false },
          { key: 'provider-b:model-b', providerId: 'provider-b', modelId: 'model-b', historical: false },
        ]}
        getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? 'AI', providerName: '' })}
        renderUser={(message) => <div>{message.content}</div>}
        renderAnswer={(message) => <div>{message.content}</div>}
      />,
    );

    expect(screen.getByLabelText('chat.multiModel.laneWorkspaceLabel')).toBeInTheDocument();
    expect(screen.getAllByText('compare these models')).toHaveLength(2);
    expect(screen.getByText('answer A')).toBeInTheDocument();
    expect(screen.getByText('answer B')).toBeInTheDocument();
  });

  it('uses split columns with expand and stop controls in the independent window', () => {
    const user = makeMessage({
      id: 'user-1',
      role: 'user',
      content: 'hello',
      parent_message_id: null,
      model_id: null,
      provider_id: null,
    });
    const answerA = makeMessage({
      id: 'a',
      content: 'answer A',
      provider_id: 'provider-a',
      model_id: 'model-a',
    });
    const answerB = makeMessage({
      id: 'b',
      content: 'answer B',
      provider_id: 'provider-b',
      model_id: 'model-b',
      version_index: 1,
      is_active: false,
    });
    const onStopColumn = vi.fn();

    render(
      <MultiModelLaneWorkspace
        userMessages={[user]}
        versionsByParentId={{ 'user-1': [answerA, answerB] }}
        columns={[
          { key: 'provider-a:model-a', providerId: 'provider-a', modelId: 'model-a', historical: false },
          { key: 'provider-b:model-b', providerId: 'provider-b', modelId: 'model-b', historical: false },
        ]}
        getModelDisplayInfo={(modelId) => ({ modelName: modelId ?? 'AI', providerName: '' })}
        renderUser={(message) => <div>{message.content}</div>}
        renderAnswer={(message) => <div>{message.content}</div>}
        streamingMessageId="a"
        variant="split"
        onStopColumn={onStopColumn}
      />,
    );

    expect(screen.getAllByLabelText('chat.multiModel.expandColumn')).toHaveLength(2);
    screen.getAllByLabelText('chat.multiModel.stopColumn')[0]?.click();
    expect(onStopColumn).toHaveBeenCalled();
  });
});
