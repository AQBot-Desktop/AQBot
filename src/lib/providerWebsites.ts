/**
 * Official website URLs for built-in providers, keyed by `builtin_id`.
 * Used in provider detail to open the vendor homepage in the system browser.
 */
const BUILTIN_PROVIDER_WEBSITES: Record<string, string> = {
  openai: 'https://openai.com',
  openai_responses: 'https://openai.com',
  gemini: 'https://ai.google.dev',
  anthropic: 'https://www.anthropic.com',
  deepseek: 'https://www.deepseek.com',
  xai: 'https://x.ai',
  glm: 'https://open.bigmodel.cn',
  siliconflow: 'https://siliconflow.cn',
  minimax: 'https://www.minimax.io',
  shuaiapi: 'https://api.shuaiapi.com',
  gptnb: 'https://goapi.gptnb.ai',
  newapi: 'https://www.newapi.ai',
  jina: 'https://jina.ai',
  cohere: 'https://cohere.com',
  voyage: 'https://www.voyageai.com',
};

/** Return the official website URL for a built-in provider, or null if unknown / custom. */
export function getBuiltinProviderWebsite(builtinId: string | null | undefined): string | null {
  if (!builtinId) return null;
  return BUILTIN_PROVIDER_WEBSITES[builtinId] ?? null;
}

export function openExternalUrl(url: string): void {
  import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(url))
    .catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
}
