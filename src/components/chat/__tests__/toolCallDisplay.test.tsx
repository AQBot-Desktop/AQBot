import { describe, expect, it } from 'vitest';

import type { Message } from '@/types';
import { buildAssistantDisplayContent, shouldHideAssistantBubble } from '../toolCallDisplay';

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
    ...overrides,
  };
}

describe('buildAssistantDisplayContent', () => {
  it('returns content as-is for assistant messages', () => {
    const msg = makeMessage({ content: 'Hello world' });
    expect(buildAssistantDisplayContent(msg, [])).toBe('Hello world');
  });

  it('returns content with :::mcp containers unchanged', () => {
    const content = ':::mcp {"name":"@aqbot/fetch","tool":"fetch_url"}\nresult\n:::\n';
    const msg = makeMessage({ content });
    expect(buildAssistantDisplayContent(msg, [])).toBe(content);
  });

  it('does not hide an empty normal assistant placeholder bubble while streaming', () => {
    const assistant = makeMessage({
      id: 'assistant-streaming',
      content: '',
      tool_calls_json: null,
    });

    expect(shouldHideAssistantBubble(assistant, '')).toBe(false);
  });

  it('hides assistant bubble with empty content but present tool_calls_json', () => {
    const assistant = makeMessage({
      content: '',
      tool_calls_json: '[{"id":"call-1","type":"function","function":{"name":"fetch","arguments":"{}"}}]',
    });

    expect(shouldHideAssistantBubble(assistant, '')).toBe(true);
  });
});
