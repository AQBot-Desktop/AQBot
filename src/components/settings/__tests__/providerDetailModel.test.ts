import { describe, expect, it } from 'vitest';
import { getProviderDefaultHost } from '../providerDetailModel';

describe('getProviderDefaultHost', () => {
  it('returns an empty host for New API because it has no official endpoint', () => {
    expect(getProviderDefaultHost({
      builtin_id: 'newapi',
      provider_type: 'openai',
    })).toBe('');
  });

  it('keeps the OpenAI official host for the OpenAI builtin', () => {
    expect(getProviderDefaultHost({
      builtin_id: 'openai',
      provider_type: 'openai',
    })).toBe('https://api.openai.com');
  });

  it('uses the type default for custom providers', () => {
    expect(getProviderDefaultHost({
      builtin_id: null,
      provider_type: 'custom',
    })).toBe('');
  });
});
