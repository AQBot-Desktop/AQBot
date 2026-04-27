import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(...segments: string[]) {
  return fs.readFileSync(path.resolve(process.cwd(), ...segments), 'utf8');
}

describe('Phase C output control regressions', () => {
  it('lets assistant replies enter the shared edit flow instead of restricting edits to user prompts', () => {
    const source = readSource('src/components/chat/ChatView.tsx');

    expect(source).toContain('editingMessageRole');
    expect(source).toContain("msg.role === 'assistant'");
    expect(source).toContain("key: 'edit'");
    expect(source).toContain("editingMessageRole === 'assistant'");
  });

  it('shows a per-turn total token summary alongside prompt and completion counts', () => {
    const source = readSource('src/components/chat/ChatView.tsx');

    expect(source).toContain('const totalTokens = (msg.prompt_tokens ?? 0) + (msg.completion_tokens ?? 0);');
    expect(source).toContain('{formatTokenCount(totalTokens)} tokens');
    expect(source).not.toContain("t('chat.totalTokens'");
  });

  it('adds transcript copy and no-thinking export variants at chat level', () => {
    const source = readSource('src/components/chat/ChatView.tsx');

    expect(source).toContain("key: 'copy-md'");
    expect(source).toContain("key: 'export-md-no-thinking'");
    expect(source).toContain("key: 'export-json-no-thinking'");
  });

  it('lets export helpers optionally strip thinking content before saving or copying', () => {
    const source = readSource('src/lib/exportChat.ts');

    expect(source).toContain('includeThinking');
    expect(source).toContain('stripAqbotTags');
    expect(source).toContain('copyTranscript');
  });
});
