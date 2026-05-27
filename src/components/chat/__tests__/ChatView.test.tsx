import { describe, expect, it } from 'vitest';

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
