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
});