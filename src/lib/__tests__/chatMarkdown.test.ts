import { describe, expect, it } from 'vitest';

import { parseChatMarkdown } from '../chatMarkdown';

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
});
