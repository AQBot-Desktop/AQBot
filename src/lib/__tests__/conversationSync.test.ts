import { afterEach, describe, expect, it } from 'vitest';
import {
  emitConversationSync,
  listenConversationSync,
} from '../conversationSync';
import { setCurrentWindowLabel } from '../windowKind';

describe('conversation sync bus', () => {
  afterEach(() => {
    setCurrentWindowLabel('main');
  });

  it('delivers mutations to other listeners with the originating window label', async () => {
    const received: Array<{ conversationId: string; originWindow: string }> = [];
    const unlisten = await listenConversationSync((payload) => {
      received.push({
        conversationId: payload.conversationId,
        originWindow: payload.originWindow,
      });
    });

    setCurrentWindowLabel('conversation-popout:conv-1');
    await emitConversationSync({ conversationId: 'conv-1', kind: 'messages-changed' });

    expect(received).toEqual([
      { conversationId: 'conv-1', originWindow: 'conversation-popout:conv-1' },
    ]);
    unlisten();
  });

  it('forwards the current stream snapshot to other windows', async () => {
    const received: Array<{ streaming?: boolean; parent?: string | null }> = [];
    const unlisten = await listenConversationSync((payload) => {
      received.push({
        streaming: payload.stream?.streaming,
        parent: payload.stream?.multiModelParentId,
      });
    });

    setCurrentWindowLabel('conversation-popout:conv-1');
    await emitConversationSync({
      conversationId: 'conv-1',
      kind: 'messages-changed',
      stream: {
        streaming: true,
        streamingMessageId: 'assistant-a',
        multiModelParentId: 'user-1',
        pendingCompanionModels: [],
        multiModelDoneMessageIds: [],
      },
    });

    expect(received).toEqual([{ streaming: true, parent: 'user-1' }]);
    unlisten();
  });
});