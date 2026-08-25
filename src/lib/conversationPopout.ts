import { invoke } from '@/lib/invoke';
import {
  conversationPopoutWindowLabel,
  getCurrentWindowLabel,
  isSafeConversationId,
} from '@/lib/windowKind';

export async function notifyConversationPopoutReady(conversationId: string): Promise<void> {
  if (!conversationId) return;
  await invoke('report_conversation_popout_ready', { conversationId });
}

export async function openConversationPopout(conversationId: string): Promise<void> {
  const trimmed = conversationId.trim();
  if (!isSafeConversationId(trimmed)) {
    throw new Error('invalid conversation id');
  }
  if (getCurrentWindowLabel() === conversationPopoutWindowLabel(trimmed)) {
    return;
  }
  await invoke('open_conversation_popout', { conversationId: trimmed });
}
