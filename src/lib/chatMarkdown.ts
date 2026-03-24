import { getMarkdown, parseMarkdownToStructure, type BaseNode } from 'stream-markdown-parser';

export type ChatMarkdownNode = BaseNode;

export const CHAT_CUSTOM_HTML_TAGS = ['thinking', 'web-search'] as const;

const chatMarkdown = getMarkdown('aqbot-chat', {
  customHtmlTags: CHAT_CUSTOM_HTML_TAGS,
});

export function parseChatMarkdown(content: string): ChatMarkdownNode[] {
  return parseMarkdownToStructure(content, chatMarkdown, {
    customHtmlTags: [...CHAT_CUSTOM_HTML_TAGS],
  });
}
