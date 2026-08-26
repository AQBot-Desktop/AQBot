import { useConversationStore } from '@/stores/conversationStore';

export function useStreamActivity(messageId: string | null | undefined) {
  return useConversationStore((state) => (
    messageId ? state.streamActivityByMessageId[messageId] : undefined
  ));
}
