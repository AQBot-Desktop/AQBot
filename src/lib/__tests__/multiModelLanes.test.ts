import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { buildLaneColumns, filterVersionsForLane, selectLaneAnswer, shouldHideMultiModelLayoutSwitcher, shouldUseLaneWorkspace } from '../multiModelLanes';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'assistant',
    content: '',
    provider_id: 'provider-1',
    model_id: 'model-1',
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

describe('multi-model lane helpers', () => {
  it('keeps only the currently selected models and ignores historical extras', () => {
    const columns = buildLaneColumns([
      { providerId: 'provider-a', modelId: 'model-a' },
      { providerId: 'provider-b', modelId: 'model-b' },
    ]);

    expect(columns.map((column) => column.modelId)).toEqual(['model-a', 'model-b']);
    expect(columns.every((column) => column.historical === false)).toBe(true);
    expect(buildLaneColumns([])).toEqual([]);
  });

  it('uses per-model columns only in the independent window', () => {
    const twoColumns = buildLaneColumns([
      { providerId: 'provider-a', modelId: 'model-a' },
      { providerId: 'provider-b', modelId: 'model-b' },
    ]);
    expect(shouldUseLaneWorkspace('popout', twoColumns)).toBe(true);
    expect(shouldUseLaneWorkspace('main', twoColumns)).toBe(false);
    expect(shouldUseLaneWorkspace('popout', twoColumns.slice(0, 1))).toBe(false);
    expect(shouldUseLaneWorkspace('popout', buildLaneColumns([]))).toBe(false);
  });

  it('hides the multi-model layout switcher in the independent window', () => {
    expect(shouldHideMultiModelLayoutSwitcher('popout')).toBe(true);
    expect(shouldHideMultiModelLayoutSwitcher('main')).toBe(false);
  });

  it('keeps only the current lane versions for a column footer', () => {
    const column = {
      key: 'provider-b:model-b',
      providerId: 'provider-b',
      modelId: 'model-b',
      historical: false,
    };
    const versions = [
      makeMessage({ id: 'a', provider_id: 'provider-a', model_id: 'model-a', version_index: 0 }),
      makeMessage({ id: 'b', provider_id: 'provider-b', model_id: 'model-b', version_index: 1 }),
      makeMessage({ id: 'b2', provider_id: 'provider-b', model_id: 'model-b', version_index: 3 }),
    ];
    expect(filterVersionsForLane(versions, column).map((message) => message.id)).toEqual(['b', 'b2']);
  });

  it('projects the slotted answer for a lane even when versions arrive out of order', () => {
    const column = {
      key: 'provider-b:model-b',
      providerId: 'provider-b',
      modelId: 'model-b',
      historical: false,
    };
    const answer = selectLaneAnswer(
      [
        makeMessage({ id: 'c', provider_id: 'provider-c', model_id: 'model-c', version_index: 2 }),
        makeMessage({ id: 'b', provider_id: 'provider-b', model_id: 'model-b', version_index: 1 }),
        makeMessage({ id: 'a', provider_id: 'provider-a', model_id: 'model-a', version_index: 0 }),
      ],
      column,
    );
    expect(answer?.id).toBe('b');
  });
});
