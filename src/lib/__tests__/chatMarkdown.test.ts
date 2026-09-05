import { describe, expect, it } from 'vitest';

import {
  parseChatMarkdown,
  safeParseChatMarkdown,
  shouldUsePlainTextChatContent,
  stripAqbotTags,
} from '../chatMarkdown';

describe('parseChatMarkdown', () => {
  it('parses fenced code blocks into markdown nodes', () => {
    const nodes = parseChatMarkdown('```ts\nconst value = 1;\n```');

    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.some((node) => node.type === 'code_block')).toBe(true);
  });

  it('parses stored assistant d2 replies as a single d2 code block node', () => {
    const nodes = parseChatMarkdown(`\`\`\`d2
User: 用户
UI: 登录页
Auth: 认证服务
DB: 用户库
MFA: 二次验证
Token: Token/Session
App: 业务系统

User -> UI: 输入账号/密码
UI -> Auth: 提交凭证
Auth -> DB: 查询用户 + 校验密码哈希
DB -> Auth: 返回用户记录

Auth -> MFA: 需要二次验证？
MFA -> User: 发送验证码/Push
User -> UI: 输入验证码
UI -> Auth: 提交验证码
Auth -> MFA: 校验验证码

Auth -> Token: 签发 JWT/Session
Token -> Auth: 返回令牌/会话
Auth -> UI: 登录成功(含token)
UI -> App: 携带token访问
\`\`\``);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: 'code_block',
      language: 'd2',
    });
  });

  it('parses inline native think tags as a think node before answer text', () => {
    const nodes = parseChatMarkdown('<think>好的，用户让我讲个笑话。</think>\n\nanswer');

    expect(nodes[0]).toMatchObject({
      type: 'think',
      content: '好的，用户让我讲个笑话。',
    });
    expect(nodes[1]).toMatchObject({
      type: 'paragraph',
    });
  });

  it('does not normalize think-looking text inside fenced code blocks', () => {
    const nodes = parseChatMarkdown('```html\n<think>literal</think>\n```');

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: 'code_block',
    });
    expect(String(nodes[0].code)).toContain('<think>literal</think>');
  });

  it('parses html-render tags as custom render nodes', () => {
    const nodes = parseChatMarkdown('<html-render><div class="card">ok</div></html-render>');

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: 'html-render',
      content: '<div class="card">ok</div>',
    });
  });

  it('does not parse html-render tags inside fenced code blocks', () => {
    const nodes = parseChatMarkdown('```html\n<html-render><div>literal</div></html-render>\n```');

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: 'code_block',
    });
    expect(String(nodes[0].code)).toContain('<html-render><div>literal</div></html-render>');
  });

  it('parses completed html-render comment markers as custom render nodes', () => {
    const nodes = parseChatMarkdown('<!-- html-render-start --><section>legacy</section><!-- html-render-end -->');

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: 'html-render',
      content: '<section>legacy</section>',
    });
  });

  it('falls incomplete final html-render tags back to source text', () => {
    const nodes = parseChatMarkdown('<html-render><div>draft');
    const serialized = JSON.stringify(nodes);

    expect(nodes.some((node) => node.type === 'html-render')).toBe(false);
    expect(serialized).toContain('<html-render><div>draft');
  });

  it('keeps a tool-call summary that ends with a Windows path backslash', () => {
    const summary = 'C:\\';
    const nodes = parseChatMarkdown(
      `<tool-call data-aqbot="1" id="a" name="Bash">${summary}</tool-call>\n\n## 标题\n\n1. 内容`,
    );

    expect(nodes.some((node) => node.type === 'tool-call' && (node as { content?: string }).content === summary)).toBe(true);
    expect(nodes.some((node) => node.type === 'heading' && (node as { text?: string }).text === '标题')).toBe(true);
    expect(JSON.stringify(nodes)).toContain('内容');
  });

  it('does not treat dollar amounts in a market sentence as math', () => {
    const nodes = parseChatMarkdown('本周从 $4,713高点回落约 **6%**，目前 $4,365');
    const serialized = JSON.stringify(nodes);

    expect(serialized).not.toContain('"type":"math_inline"');
    expect(serialized).toContain('$4,713');
    expect(serialized).toContain('$4,365');
    expect(serialized).toContain('6%');
  });

  it('strips think and aqbot-only tags when preparing export-safe transcript text', () => {
    const cleaned = stripAqbotTags(`Final answer
<think>Hidden reasoning</think>
<web-search-query data-aqbot="1">query</web-search-query>
<knowledge-retrieval data-aqbot="1">retrieved</knowledge-retrieval>
<web-search data-aqbot="1">[{"title":"A"}]</web-search>
:::mcp tool
payload
:::
Visible tail`);

    expect(cleaned).toBe('Final answer\nVisible tail');
  });

  it('keeps user-visible html-render content in export-safe transcript text', () => {
    const content = '<html-render><div>visible html</div></html-render>';

    expect(stripAqbotTags(content)).toBe(content);
  });

  it('preserves user pasted think-like logs when think stripping is disabled', () => {
    const content = 'before\n<think>literal user log</think>\nafter';

    expect(stripAqbotTags(content, { stripThink: false })).toBe(content);
    expect(stripAqbotTags(content, { stripThink: true })).toBe('before\nafter');
  });

  it('keeps malformed or non-aqbot display tags as literal transcript text', () => {
    const content = [
      'visible',
      '<web-search status="done">user-visible</web-search>',
      '<knowledge-retrieval data-aqbot="1">missing close',
      '<tool-call data-aqbot="1">also missing close',
      'tail',
    ].join('\n');

    expect(stripAqbotTags(content)).toBe(content);
  });

  it('strips only complete mcp fenced blocks and preserves incomplete user logs', () => {
    const complete = 'before\n:::mcp tool\npayload\n:::\nafter';
    const incomplete = 'before\n:::mcp tool\npayload\nafter';

    expect(stripAqbotTags(complete)).toBe('before\nafter');
    expect(stripAqbotTags(incomplete)).toBe(incomplete);
  });

  it('handles a 130kb malformed ai-system-log paste without dropping user text', () => {
    const malformedLog = [
      '<system-reminder>do not drop this',
      '<user_input>keep this input',
      '<think>literal log start',
      ...Array.from({ length: 38 }, (_, index) => `<tool_call_${index}>${'x'.repeat(3200)}`),
      'visible tail',
    ].join('\n').slice(0, 130_268);

    expect(() => stripAqbotTags(malformedLog, { stripThink: false })).not.toThrow();
    const cleaned = stripAqbotTags(malformedLog, { stripThink: false });
    expect(cleaned).toContain('<system-reminder>do not drop this');
    expect(cleaned).toContain('<user_input>keep this input');
    expect(cleaned).toContain('<think>literal log start');
  });

  it('classifies long malformed user logs for plain-text rendering', () => {
    const content = [
      '<system-reminder>open',
      '<user_input>open',
      ...Array.from({ length: 28 }, (_, index) => `<tag-${index}>${'x'.repeat(4000)}`),
    ].join('\n');

    expect(content.length).toBeGreaterThan(100_000);
    expect(shouldUsePlainTextChatContent(content, { role: 'user', isStreaming: false })).toBe(true);
    expect(shouldUsePlainTextChatContent('short <tag> log', { role: 'user', isStreaming: false })).toBe(false);
    expect(shouldUsePlainTextChatContent(content, { role: 'assistant', isStreaming: false })).toBe(false);
  });

  it('returns plain text nodes from the safe parser when markdown parsing throws', () => {
    const nodes = safeParseChatMarkdown('literal <broken>', {
      parse: () => {
        throw new Error('parser failed');
      },
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: 'paragraph',
      raw: 'literal <broken>',
    });
    expect(JSON.stringify(nodes)).toContain('literal <broken>');
  });
});
