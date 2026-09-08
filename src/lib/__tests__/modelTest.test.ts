import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: vi.fn(),
}));

import { adapterSupportsKind, modelTestKind, normalizeModelTestPrompt } from '../modelTest';
import type { Model, ModelTestConfig } from '@/types';

describe('modelTest helpers', () => {
  it('treats blank prompts as the official default', () => {
    expect(normalizeModelTestPrompt('  \n')).toBeNull();
    expect(normalizeModelTestPrompt(null)).toBeNull();
  });

  it('rejects prompts over 2000 unicode characters', () => {
    expect(() => normalizeModelTestPrompt('测'.repeat(2001))).toThrow('prompt_too_long');
    expect(normalizeModelTestPrompt('测'.repeat(2000))).toHaveLength(2000);
  });

  it('maps model types and adapter capabilities', () => {
    const model = { model_type: 'Embedding' } as Model;
    expect(modelTestKind(model)).toBe('embedding');
    const config: ModelTestConfig = {
      default_prompt: 'Say 1',
      max_prompt_chars: 2000,
      timeout_secs: 120,
      adapter_kinds: [{ provider_type: 'bedrock', kinds: ['chat'] }],
    };
    expect(adapterSupportsKind(config, 'bedrock', 'embedding')).toBe(false);
    expect(adapterSupportsKind(config, 'bedrock', 'chat')).toBe(true);
  });
});
