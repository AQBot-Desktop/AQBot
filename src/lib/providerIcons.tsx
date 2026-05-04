import { memo } from 'react';
import type { ProviderConfig } from '@/types';
import { ProviderIcon, ModelIcon, providerMappings, modelMappings } from '@lobehub/icons';
import { DynamicLobeIcon } from '@/components/shared/DynamicLobeIcon';

const TYPE_TO_PROVIDER: Record<string, string> = {
  openai: 'openai',
  openai_responses: 'openai',
  deepseek: 'deepseek',
  xai: 'xai',
  glm: 'zhipu',
  siliconflow: 'siliconcloud',
  anthropic: 'anthropic',
  gemini: 'google',
  jina: 'jina',
  cohere: 'cohere',
  voyage: 'voyage',
  custom: 'openai',
};

/**
 * Check if a name matches any providerMappings keyword (exact, lowercased).
 */
function findProviderKey(name: string): string | null {
  const lower = name.toLowerCase().replace(/\s+/g, '');
  for (const mapping of providerMappings) {
    if (mapping.keywords.some((kw: string) => lower.includes(kw.toLowerCase()))) {
      return mapping.keywords[0];
    }
  }
  return null;
}

/**
 * Check if a name matches any modelMappings keyword using regex (same as ModelIcon internals).
 */
function findModelKey(name: string): string | null {
  const lower = name.toLowerCase().replace(/\s+/g, '');
  for (const mapping of modelMappings) {
    if (mapping.keywords.some((kw: string) => {
      try {
        return new RegExp(kw, 'i').test(lower);
      } catch {
        return lower.includes(kw.toLowerCase());
      }
    })) {
      return mapping.keywords[0];
    }
  }
  return null;
}

export type IconResult = {
  type: 'provider';
  key: string;
} | {
  type: 'model';
  key: string;
};

// Explicit name-to-provider fallback for names that don't match
// either providerMappings or modelMappings keywords.
const NAME_TO_PROVIDER: Record<string, string> = {
  glm: 'zhipu',
};

/**
 * Resolve a ProviderConfig to the best icon match.
 * 1) providerMappings keyword match → ProviderIcon
 * 2) modelMappings keyword match → ModelIcon
 * 3) NAME_TO_PROVIDER explicit mapping → ProviderIcon
 * 4) TYPE_TO_PROVIDER fallback → ProviderIcon
 */
export function resolveProviderIcon(provider: ProviderConfig): IconResult {
  const providerKey = findProviderKey(provider.name);
  if (providerKey) return { type: 'provider', key: providerKey };

  const modelKey = findModelKey(provider.name);
  if (modelKey) return { type: 'model', key: modelKey };

  const nameLower = provider.name.toLowerCase().replace(/\s+/g, '');
  for (const [keyword, icon] of Object.entries(NAME_TO_PROVIDER)) {
    if (nameLower.includes(keyword)) return { type: 'provider', key: icon };
  }

  return { type: 'provider', key: TYPE_TO_PROVIDER[provider.provider_type] || 'openai' };
}

/**
 * Legacy helper — returns a ProviderIcon-compatible string key.
 * Prefer resolveProviderIcon + SmartProviderIcon for correct two-tier rendering.
 */
export function getProviderIconKey(provider: ProviderConfig): string {
  const result = resolveProviderIcon(provider);
  return result.key;
}

/**
 * Two-tier icon component: tries ProviderIcon first, then ModelIcon, then fallback.
 */
export const SmartProviderIcon = memo(function SmartProviderIcon({
  provider,
  size = 22,
  type = 'color',
  shape,
}: {
  provider: ProviderConfig;
  size?: number;
  type?: 'avatar' | 'color' | 'mono';
  shape?: 'circle' | 'square';
}) {
  if (provider.icon) {
    const [, key] = provider.icon.includes(':')
      ? (provider.icon.split(':', 2) as [string, string])
      : ['model' as const, provider.icon];
    // key is a toc `id` (e.g., "Ai302", "OpenAI") — use DynamicLobeIcon for reliable rendering
    return <DynamicLobeIcon iconId={key} size={size} type={type} />;
  }
  const result = resolveProviderIcon(provider);
  if (result.type === 'model') {
    return <ModelIcon model={result.key} size={size} type={type} />;
  }
  return <ProviderIcon provider={result.key} size={size} type={type} shape={shape} />;
}, (prev, next) =>
  prev.provider.icon === next.provider.icon
  && prev.provider.name === next.provider.name
  && prev.provider.provider_type === next.provider.provider_type
  && prev.size === next.size
  && prev.type === next.type
  && prev.shape === next.shape
);
