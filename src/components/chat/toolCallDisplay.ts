import type { Message } from '@/types';
import { stripAqbotTags } from '@/lib/chatMarkdown';
import { buildSearchQueryTag, buildSearchTag, parseSearchContent } from '@/lib/searchUtils';
import { splitLeadingAqbotDisplayContent } from './chatStreaming';
import { splitStreamErrorContent } from '@/lib/streamStatus';

const MCP_RENDER_BLOCK_CHAR_LIMIT = 20_000;
const MCP_RENDER_TRUNCATED_NOTICE = 'MCP output truncated for rendering';

function hasPersistedDisplayTag(content: string): boolean {
  return /<(?:web-search-query|web-search|knowledge-retrieval|memory-retrieval)\b[^>]*data-aqbot=["']1["'][^>]*>/i.test(content);
}

function sliceCodePoints(content: string, limit: number): string {
  let count = 0;
  let end = 0;
  for (const char of content) {
    if (count >= limit) break;
    end += char.length;
    count += 1;
  }
  return content.slice(0, end);
}

function truncatePersistedMcpBlocks(content: string): string {
  let result = '';
  let offset = 0;

  while (offset < content.length) {
    const opener = content.indexOf(':::mcp', offset);
    if (opener === -1) {
      result += content.slice(offset);
      break;
    }

    const headerEnd = content.indexOf('\n', opener);
    if (headerEnd === -1) {
      result += content.slice(offset);
      break;
    }

    const closer = content.indexOf('\n:::', headerEnd + 1);
    if (closer === -1) {
      result += content.slice(offset);
      break;
    }

    const bodyStart = headerEnd + 1;
    const body = content.slice(bodyStart, closer);
    result += content.slice(offset, bodyStart);

    if (Array.from(body).length > MCP_RENDER_BLOCK_CHAR_LIMIT) {
      result += sliceCodePoints(body, MCP_RENDER_BLOCK_CHAR_LIMIT);
      result += `\n\n[${MCP_RENDER_TRUNCATED_NOTICE}: showing first ${MCP_RENDER_BLOCK_CHAR_LIMIT} characters]`;
    } else {
      result += body;
    }

    offset = closer;
  }

  return result;
}

export function buildAssistantDisplayContent(message: Message, messages: Message[]): string {
  if (message.role !== 'assistant') {
    return message.content;
  }

  let content = truncatePersistedMcpBlocks(message.content);
  if (message.status === 'error' || hasPersistedDisplayTag(content)) {
    return content;
  }

  const parent = message.parent_message_id
    ? messages.find((item) => item.id === message.parent_message_id && item.role === 'user')
    : undefined;
  if (!parent) {
    return content;
  }

  const parentSearch = parseSearchContent(parent.content);
  if (!parentSearch.hasSearch) {
    return content;
  }

  const queryTag = parentSearch.queryStatus || parentSearch.query
    ? buildSearchQueryTag(parentSearch.queryStatus ?? 'done', parentSearch.query ?? undefined, parentSearch.queryError ?? undefined)
    : '';
  const searchTag = buildSearchTag(
    parentSearch.status ?? 'done',
    parentSearch.sources.map((source) => ({ ...source, content: '' })),
    parentSearch.error ?? undefined,
  );
  content = `${queryTag}${searchTag}${content}`;
  return content;
}

export function splitAssistantErrorDisplayContent(content: string): { prefix: string; message: string } {
  const streamError = splitStreamErrorContent(content);
  if (streamError) {
    return {
      prefix: streamError.prefix,
      message: stripAqbotTags(streamError.error).trim() || streamError.error,
    };
  }

  const split = splitLeadingAqbotDisplayContent(content);
  const cleanBody = stripAqbotTags(split.body).trim();
  const cleanFullContent = stripAqbotTags(content).trim();

  return {
    prefix: split.prefix,
    message: cleanBody || cleanFullContent || split.body.trim() || content.trim(),
  };
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
