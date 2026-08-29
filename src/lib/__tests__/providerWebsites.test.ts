import { describe, expect, it } from 'vitest';
import { getBuiltinProviderWebsite } from '../providerWebsites';

describe('getBuiltinProviderWebsite', () => {
  it('returns official URLs for known built-in providers', () => {
    expect(getBuiltinProviderWebsite('openai')).toBe('https://openai.com');
    expect(getBuiltinProviderWebsite('anthropic')).toBe('https://www.anthropic.com');
    expect(getBuiltinProviderWebsite('deepseek')).toBe('https://www.deepseek.com');
    expect(getBuiltinProviderWebsite('shuaiapi')).toBe('https://api.shuaiapi.com');
    expect(getBuiltinProviderWebsite('gptnb')).toBe('https://goapi.gptnb.ai');
    expect(getBuiltinProviderWebsite('newapi')).toBe('https://www.newapi.ai');
  });

  it('returns null for custom or missing providers', () => {
    expect(getBuiltinProviderWebsite(null)).toBeNull();
    expect(getBuiltinProviderWebsite(undefined)).toBeNull();
    expect(getBuiltinProviderWebsite('custom-xyz')).toBeNull();
  });
});
