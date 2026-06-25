import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Message } from '@/types';
import {
  buildAssistantDisplayContent,
  splitAssistantErrorDisplayContent,
} from '../toolCallDisplay';
import {
  resolveAssistantMessageForBubbleKey,
} from '../chatMessageLookup';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'assistant',
    content: '',
    provider_id: null,
    model_id: null,
    token_count: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: 1,
    parent_message_id: null,
    version_index: 0,
    is_active: true,
    status: 'complete',
    ...overrides,
  };
}

describe('ChatView assistant display policy', () => {
  it('does not mount AssistantFooter while an assistant message is streaming', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');
    const footerBranch = source.match(/footer:\s*msg && activeConversationId \? \([\s\S]*?\) : footerLoading \?/);

    expect(footerBranch?.[0]).toContain('{!isStreaming && (');
    expect(footerBranch?.[0]).not.toContain('isStreaming={isStreaming}');
  });

  it('temporarily closes live streaming think content before rendering', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');

    expect(source).toMatch(/renderContentNode\(\s*closeStreamingThinkBlock\(\s*liveContent,/);
  });

  it('uses a finite live markdown window instead of placeholder batching', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');
    const propsBlock = source.match(/const CHAT_RENDER_BATCH_PROPS = \{[\s\S]*?\} as const;/)?.[0] ?? '';

    expect(propsBlock).toContain('deferNodesUntilVisible: false');
    expect(propsBlock).toMatch(/maxLiveNodes:\s*[1-9]\d*,/);
    expect(propsBlock).not.toMatch(/maxLiveNodes:\s*(?:0|Infinity),/);
  });

  it('routes plain text and markdown messages through chat typography classes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');

    expect(source).toContain('className="aqbot-chat-text"');
    expect(source).toContain('className="aqbot-chat-markdown"');
  });

  it('defines chat typography CSS without overriding code font settings', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const chatBlock = source.match(/\.aqbot-chat-text,[\s\S]*?\.aqbot-chat-markdown \.markdown-renderer \{[\s\S]*?\}/)?.[0] ?? '';
    const codeBlock = source.match(/\.aqbot-chat-markdown (?:pre|code)[\s\S]*?\}/)?.[0] ?? '';

    expect(chatBlock).toContain('font-family: var(--chat-font-family');
    expect(chatBlock).toContain('font-size: var(--chat-font-size');
    expect(chatBlock).toContain('line-height: var(--chat-line-height');
    expect(chatBlock).toContain('font-weight: var(--chat-font-weight');
    expect(codeBlock).toContain('font-family: var(--code-font-family');
    expect(codeBlock).not.toContain('--chat-font-family');
  });

  it('resolves stable ai bubble keys through their parent message id', () => {
    const assistant = makeMessage({
      id: 'assistant-1',
      parent_message_id: 'user-1',
      content: 'final answer',
    });
    const assistantByParentId = new Map<string, Message>([['user-1', assistant]]);
    const messageById = new Map<string, Message>([
      ['user-1', makeMessage({ id: 'user-1', role: 'user', content: 'question' })],
      ['assistant-1', assistant],
    ]);

    expect(resolveAssistantMessageForBubbleKey(
      'ai:user-1',
      assistantByParentId,
      messageById,
    )).toBe(assistant);
  });

  it('loads a message window when minimap targets a message that is not mounted yet', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');
    const minimapScrollTo = source.match(/const minimapScrollTo = useCallback\(\(messageId: string\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0] ?? '';

    expect(minimapScrollTo).toContain('loadMessagesAround');
    expect(minimapScrollTo).toContain('MINIMAP_JUMP_BEFORE_LIMIT');
    expect(minimapScrollTo).toContain('MINIMAP_JUMP_AFTER_LIMIT');
    expect(minimapScrollTo).toContain('data-aqbot-msg="${messageId}"');
    expect(minimapScrollTo).toContain('requestAnimationFrame');
  });

  it('only loads older pages after a user scroll intent reaches history top', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');
    const scrollHandler = source.match(/const handleBubbleListScroll = useCallback\(\(event: React\.UIEvent<HTMLDivElement>\) => \{[\s\S]*?\n  \}, \[[\s\S]*?\]\);/)?.[0] ?? '';

    expect(scrollHandler).toContain('hadRecentUserScrollIntent');
    expect(scrollHandler).toMatch(/if \(!hasOlderMessages \|\| !hadRecentUserScrollIntent\) return;/);
    expect(scrollHandler).toContain('void handleLoadOlderMessages();');
  });

  it('defers parsing assistant code blocks until the message becomes visible', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');
    const nodesMemo = source.match(/const aiContentNodesById = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0] ?? '';

    expect(nodesMemo).toContain('shouldDeferAssistantMarkdownParse(item.content)');
    expect(nodesMemo.indexOf('shouldDeferAssistantMarkdownParse(item.content)')).toBeLessThan(
      nodesMemo.indexOf('safeParseChatMarkdown(item.content)'),
    );
  });

  it('does not refetch every assistant version when unrelated pages change message count', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');

    expect(source).not.toContain('const messagesLength = useConversationStore((s) => s.messages.length);');
    expect(source).not.toMatch(/listMessageVersions\([\s\S]*?\], \[[^\]]*messagesLength[^\]]*\]\);/);
  });

  it('injects a web-search display card for normal assistant replies with searched parent messages', () => {
    const user = makeMessage({
      id: 'user-1',
      role: 'user',
      content: '<!-- search:{"sources":[{"title":"A","url":"https://example.com"}],"query":"AQBot 下载"} -->\nsearch\n---\n\n用户问题',
    });
    const assistant = makeMessage({
      id: 'assistant-1',
      parent_message_id: 'user-1',
      content: 'final answer',
    });

    const content = buildAssistantDisplayContent(assistant, [user, assistant]);

    expect(content).toContain('<web-search status="done" data-aqbot="1"');
    expect(content).toContain('query="AQBot 下载"');
    expect(content).toContain('final answer');
  });

  it('still injects web-search display when streaming thinking content is present', () => {
    const user = makeMessage({
      id: 'user-1',
      role: 'user',
      content: '<!-- search:{"sources":[{"title":"A","url":"https://example.com"}],"query":"AQBot 下载"} -->\nsearch\n---\n\n用户问题',
    });
    const assistant = makeMessage({
      id: 'assistant-1',
      parent_message_id: 'user-1',
      content: '<think data-aqbot="1">\n正在分析搜索结果',
      status: 'partial',
    });

    const content = buildAssistantDisplayContent(assistant, [user, assistant]);

    expect(content).toContain('<web-search status="done" data-aqbot="1"');
    expect(content).toContain('<think data-aqbot="1">');
  });

  it('does not inject a web-search display card into assistant error text', () => {
    const user = makeMessage({
      id: 'user-1',
      role: 'user',
      content: '<!-- search:{"sources":[{"title":"A","url":"https://example.com"}]} -->\nsearch\n---\n\n用户问题',
    });
    const assistant = makeMessage({
      id: 'assistant-1',
      parent_message_id: 'user-1',
      content: '模型首包超时',
      status: 'error',
    });

    const content = buildAssistantDisplayContent(assistant, [user, assistant]);

    expect(content).toBe('模型首包超时');
    expect(content).not.toContain('<web-search');
  });

  it('splits display-only prefixes away from assistant error messages', () => {
    const display = splitAssistantErrorDisplayContent(
      '<web-search status="done" data-aqbot="1">[{"title":"A"}]</web-search>\n\n模型首包超时',
    );

    expect(display.prefix).toContain('<web-search status="done" data-aqbot="1">');
    expect(display.message).toBe('模型首包超时');
    expect(display.message).not.toContain('[{"title":"A"}]');
  });

  it('splits partial streamed content away from stream error messages', () => {
    const display = splitAssistantErrorDisplayContent(
      '已生成的前半段\n\n<!-- aqbot-stream-error -->\n模型响应空闲超时',
    );

    expect(display.prefix).toBe('已生成的前半段');
    expect(display.message).toBe('模型响应空闲超时');
  });

  it('truncates persisted MCP blocks before markdown rendering', () => {
    const longOutput = 'x'.repeat(25_000);
    const assistant = makeMessage({
      id: 'assistant-1',
      content: `before\n\n:::mcp {"name":"server","tool":"fetch_url"}\n${longOutput}\n:::\n\nafter`,
    });

    const content = buildAssistantDisplayContent(assistant, [assistant]);

    expect(content).toContain('before');
    expect(content).toContain('after');
    expect(content).toContain('MCP output truncated for rendering');
    expect(content.length).toBeLessThan(longOutput.length);
  });
});
