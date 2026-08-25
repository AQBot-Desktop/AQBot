import { describe, expect, it } from 'vitest';
import {
  conversationIdFromPopoutLabel,
  conversationPopoutWindowLabel,
  frontendKindForWindow,
  isSafeConversationId,
} from '../windowKind';

describe('frontendKindForWindow', () => {
  it('routes only the selection-toolbar label to the lightweight frontend', () => {
    expect(frontendKindForWindow('selection-toolbar')).toBe('selection-toolbar');
    expect(frontendKindForWindow('main')).toBe('main');
    expect(frontendKindForWindow('other')).toBe('main');
  });

  it('routes conversation popout labels to the compact chat frontend', () => {
    expect(frontendKindForWindow('conversation-popout:conv-1')).toBe('conversation-popout');
    expect(conversationIdFromPopoutLabel('conversation-popout:conv-1')).toBe('conv-1');
    expect(conversationPopoutWindowLabel('conv-1')).toBe('conversation-popout:conv-1');
    expect(isSafeConversationId('conv-1')).toBe(true);
    expect(isSafeConversationId('../secret')).toBe(false);
    expect(conversationIdFromPopoutLabel('main')).toBeNull();
  });
});
