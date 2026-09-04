export type FrontendKind = 'main' | 'selection-toolbar' | 'capture-overlay' | 'conversation-popout';

export const CONVERSATION_POPOUT_LABEL_PREFIX = 'conversation-popout:';

const MAX_CONVERSATION_ID_LEN = 128;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:/\\-]{0,127}$/;

let currentWindowLabel = 'main';

export function setCurrentWindowLabel(label: string): void {
  currentWindowLabel = label;
}

export function getCurrentWindowLabel(): string {
  return currentWindowLabel;
}

export function isSafeConversationId(conversationId: string): boolean {
  return conversationId.length > 0
    && conversationId.length <= MAX_CONVERSATION_ID_LEN
    && CONVERSATION_ID_PATTERN.test(conversationId);
}

export function conversationPopoutWindowLabel(conversationId: string): string {
  if (!isSafeConversationId(conversationId)) {
    throw new Error('invalid conversation id');
  }
  return `${CONVERSATION_POPOUT_LABEL_PREFIX}${conversationId}`;
}

export function conversationIdFromPopoutLabel(label: string): string | null {
  if (!label.startsWith(CONVERSATION_POPOUT_LABEL_PREFIX)) return null;
  const conversationId = label.slice(CONVERSATION_POPOUT_LABEL_PREFIX.length);
  return isSafeConversationId(conversationId) ? conversationId : null;
}

export function frontendKindForWindow(label: string): FrontendKind {
  if (label === 'capture-overlay') return 'capture-overlay';
  if (label === 'selection-toolbar') return 'selection-toolbar';
  if (label.startsWith(CONVERSATION_POPOUT_LABEL_PREFIX)) return 'conversation-popout';
  return 'main';
}
