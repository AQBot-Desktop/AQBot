import { describe, expect, it } from 'vitest';
import { parseProviderDeepLink } from '../providerDeepLink';

describe('parseProviderDeepLink', () => {
  it('parses provider import payload from aqbot scheme URL', () => {
    const payload = parseProviderDeepLink(
      'aqbot://providers?name=Example%20AI&baseurl=https%3A%2F%2Fapi.example.com%2Fv1!&apikey=sk-test&type=openai',
    );

    expect(payload).toEqual({
      name: 'Example AI',
      baseurl: 'https://api.example.com/v1!',
      apikey: 'sk-test',
      type: 'openai',
    });
  });

  it('parses provider import payload from triple-slash URL', () => {
    const payload = parseProviderDeepLink(
      'aqbot:///providers?name=Claude&baseurl=https%3A%2F%2Fapi.anthropic.com&apikey=sk-ant&type=anthropic',
    );

    expect(payload).toEqual({
      name: 'Claude',
      baseurl: 'https://api.anthropic.com',
      apikey: 'sk-ant',
      type: 'anthropic',
    });
  });

  it('accepts dedicated OpenAI-compatible provider types', () => {
    for (const type of ['deepseek', 'xai', 'glm', 'siliconflow'] as const) {
      const payload = parseProviderDeepLink(
        `aqbot://providers?name=${type}&baseurl=https%3A%2F%2Fapi.example.com&apikey=sk-test&type=${type}`,
      );

      expect(payload?.type).toBe(type);
    }
  });

  it('ignores links that are not provider imports', () => {
    expect(parseProviderDeepLink('aqbot://chat?name=Example')).toBeNull();
    expect(parseProviderDeepLink('https://example.com')).toBeNull();
  });

  it('ignores links missing required provider parameters', () => {
    expect(parseProviderDeepLink('aqbot://providers?name=Example&baseurl=https%3A%2F%2Fapi.example.com&apikey=sk')).toBeNull();
    expect(parseProviderDeepLink('aqbot://providers?name=Example&baseurl=https%3A%2F%2Fapi.example.com&type=openai')).toBeNull();
  });
});
