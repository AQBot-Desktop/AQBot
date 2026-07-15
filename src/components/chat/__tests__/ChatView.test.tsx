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
  it('loads stored attachment images through the read-only media source', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');
    const attachmentPreview = source.match(/function AttachmentPreview[\s\S]*?const handleOpen/)?.[0] ?? '';

    expect(attachmentPreview).toContain('loadStoredMediaSource(att.id, att.file_path)');
    expect(attachmentPreview).not.toContain("invoke<string>('read_attachment_preview'");
    expect(attachmentPreview).toMatch(
      /React\.useEffect\(\(\) => \{\s*if \(isImage \|\| fileExists !== null\) return;[\s\S]*?invoke<boolean>\('check_attachment_exists'/,
    );
    expect(attachmentPreview).toContain('onError={() => {');
  });

  it('loads the complete transcript before copy and structured exports when the message window is trimmed', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');

    expect(source).toContain('const loadCompleteTranscript = useCallback(async () => {');
    expect(source).toContain("invoke<Message[]>('list_messages'");
    expect(source).toContain('const transcript = await loadCompleteTranscript();');
    expect(source).not.toContain('exportAsMarkdown(messages,');
    expect(source).not.toContain('exportAsText(messages,');
    expect(source).not.toContain('exportAsJSON(messages,');
    expect(source).not.toContain('copyTranscript(messages,');
  });

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

  it('gates custom user and ai message area styles behind separate chat settings', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');

    expect(source).toContain("userMessageAreaStyle === 'background'");
    expect(source).toContain("userMessageAreaStyle === 'border'");
    expect(source).toContain("aiMessageAreaStyle === 'background'");
    expect(source).toContain("aiMessageAreaStyle === 'border'");
    expect(source).toContain("settings.chat_user_message_area_style ?? 'none'");
    expect(source).toContain("settings.chat_ai_message_area_style ?? 'none'");
    expect(source).toContain("'--chat-user-message-area-color': isDarkMode");
    expect(source).toContain("'--chat-ai-message-area-color': isDarkMode");
    expect(source).toContain('.bubble-user-background .ant-bubble-end .ant-bubble-content');
    expect(source).toContain('.bubble-user-border .ant-bubble-end .ant-bubble-content');
    expect(source).toContain('.bubble-ai-background .ant-bubble-start .ant-bubble-content');
    expect(source).toContain('.bubble-ai-border .ant-bubble-start .ant-bubble-content');
    expect(source).toContain('padding: 8px 12px;');
    expect(source).toContain('border-radius: 8px;');
    expect(source).toContain('margin-block: 6px;');
    expect(source).toContain('.bubble-ai-background .context-clear-bubble .ant-bubble-content');
    expect(source).toContain('.bubble-ai-border .context-clear-bubble .ant-bubble-content');
    expect(source).toContain('margin-block: 0;');
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

  it('does not repeat auto-scroll or synchronous layout reads when an Activity page reconnects', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');

    expect(source).toContain('previousRequest?.items === finalBubbleItems');
    expect(source).toContain('lastAutoScrollRequestRef.current = { items: finalBubbleItems, stickToBottom }');
    expect(source).toContain('if (scrollLayoutMetricsRef.current.scrollHeight === 0)');

    const userIntentAttach = source.match(/const attach = \(\) => \{[\s\S]*?\n    \};/)?.[0] ?? '';
    expect(userIntentAttach).not.toContain('attachedScrollBox.scrollHeight');
  });

  it('invalidates transient popovers and late async modals when Chat is suspended', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');

    expect(source).toContain('const [open, setOpen] = usePageTransientOpenState();');
    expect(source).toContain('pageConnectionGenerationRef.current !== connectionGeneration');
    expect(source).toContain('useConversationStore.getState().activeConversationId !== convId');
  });

  it('defers parsing assistant code blocks until the message becomes visible', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');
    const nodesMemo = source.match(/const aiContentNodesById = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0] ?? '';

    expect(nodesMemo).toContain('shouldDeferAssistantMarkdownParse(item.content)');
    expect(nodesMemo.indexOf('shouldDeferAssistantMarkdownParse(item.content)')).toBeLessThan(
      nodesMemo.indexOf('safeParseChatMarkdown(renderableContent)'),
    );
  });

  it('does not refetch every assistant version when unrelated pages change message count', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');

    expect(source).toContain('listMessageVersionsBatch(activeConversationId, parentMessageIds)');
    expect(source).not.toContain('const messagesLength = useConversationStore((s) => s.messages.length);');
    expect(source).not.toMatch(/listMessageVersions\([\s\S]*?\], \[[^\]]*messagesLength[^\]]*\]\);/);
  });

  it('renders role intro prompts for empty role conversations', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/ChatView.tsx'), 'utf8');

    expect(source).toContain('getRoleIntro');
    expect(source).toContain('roleIntro.openingMessage');
    expect(source).toContain('roleIntro.openingQuestions');
    expect(source).toContain('setPendingPromptText');
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
