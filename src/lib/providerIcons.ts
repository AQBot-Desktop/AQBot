import type { ProviderConfig } from '@/types';

/**
 * Maps a provider config to a @lobehub/icons provider key.
 * Uses provider name (case-insensitive) first, then falls back to provider_type.
 */
const NAME_TO_PROVIDER: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  gemini: 'google',
  google: 'google',
  deepseek: 'deepseek',
  mistral: 'mistral',
  meta: 'meta',
  llama: 'meta',
  cohere: 'cohere',
  groq: 'groq',
  perplexity: 'perplexity',
  ollama: 'ollama',
  azure: 'azure',
  aws: 'aws',
  bedrock: 'bedrock',
  huggingface: 'huggingface',
  nvidia: 'nvidia',
  together: 'togetherai',
  fireworks: 'fireworks',
  qwen: 'qwen',
  baidu: 'baidu',
  zhipu: 'zhipu',
  moonshot: 'moonshot',
  minimax: 'minimax',
  stepfun: 'stepfun',
  doubao: 'doubao',
  silicon: 'siliconcloud',
};

const TYPE_TO_PROVIDER: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  custom: 'openai',
};

export function getProviderIconKey(provider: ProviderConfig): string {
  const nameLower = provider.name.toLowerCase().replace(/\s+/g, '');
  for (const [key, value] of Object.entries(NAME_TO_PROVIDER)) {
    if (nameLower.includes(key)) return value;
  }
  return TYPE_TO_PROVIDER[provider.provider_type] || 'openai';
}
