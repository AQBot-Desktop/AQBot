import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function readSource(...segments: string[]) {
  return fs.readFileSync(path.resolve(process.cwd(), ...segments), 'utf8');
}

describe('Phase A feedback regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps chat scroll handling aligned with Bubble.List reversed layout instead of hard-coding false', () => {
    const source = readSource('src/components/chat/ChatView.tsx');
    expect(source).toContain('CHAT_SCROLL_IS_REVERSED');
    expect(source).not.toContain('shouldShowScrollToBottom(\n      target.scrollHeight,\n      target.scrollTop,\n      target.clientHeight,\n      false,');
    expect(source).not.toContain('shouldKeepAutoScroll(\n      target.scrollHeight,\n      target.scrollTop,\n      target.clientHeight,\n      false,');
    expect(source).not.toContain('getDistanceToHistoryTop(\n      target.scrollHeight,\n      target.scrollTop,\n      target.clientHeight,\n      false,');
  });

  it('gives the chat textarea a dedicated visible-scrollbar hook instead of relying on globally hidden scrollbars', () => {
    const inputAreaSource = readSource('src/components/chat/InputArea.tsx');
    const cssSource = readSource('src/index.css');

    expect(inputAreaSource).toContain('className="aqbot-input-textarea"');
    expect(cssSource).toContain('.aqbot-input-textarea');
    expect(cssSource).toMatch(/\.aqbot-input-textarea[\s\S]*scrollbar-width:\s*thin/i);
  });

  it('keeps a null conversation max tokens override visually off instead of hydrating it from the global default', () => {
    const modalSource = readSource('src/components/chat/ConversationSettingsModal.tsx');

    expect(modalSource).toContain('setMaxTokens(conversation.max_tokens ?? null)');
    expect(modalSource).not.toContain('setMaxTokens(conversation.max_tokens ?? settings.default_max_tokens ?? 4096)');
  });

  it('treats max tokens clearing as an explicit nullable contract from modal to TypeScript types to Rust persistence', () => {
    const modalSource = readSource('src/components/chat/ConversationSettingsModal.tsx');
    const typeSource = readSource('src/types/index.ts');
    const rustTypeSource = readSource('src-tauri/crates/core/src/types.rs');
    const repoSource = readSource('src-tauri/crates/core/src/repo/conversation.rs');

    expect(modalSource).toContain('max_tokens: maxTokens,');
    expect(typeSource).toMatch(/max_tokens\?: number \| null;/);
    expect(rustTypeSource).toMatch(/deserialize_double_option"\)\]\s*pub max_tokens: Option<Option<i64>>/);
    expect(repoSource).toContain('if let Some(max_tokens) = input.max_tokens {');
    expect(repoSource).toContain('am.max_tokens = Set(max_tokens);');
  });
});
