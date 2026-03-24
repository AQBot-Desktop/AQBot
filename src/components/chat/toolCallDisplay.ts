import type { Message } from '@/types';

export function buildAssistantDisplayContent(message: Message, _messages: Message[]): string {
  return message.content;
}

export function shouldHideAssistantBubble(message: Message, displayContent: string): boolean {
  if (message.role !== 'assistant') {
    return false;
  }

  if (displayContent.trim()) {
    return false;
  }

  return !message.content.trim() && Boolean(message.tool_calls_json);
}
