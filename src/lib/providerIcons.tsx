import { memo } from 'react';
import { Avatar } from 'antd';
import type { ProviderConfig } from '@/types';
import { ProviderIcon, ModelIcon, providerMappings, modelMappings } from '@lobehub/icons';
import { DynamicLobeIcon } from '@/components/shared/DynamicLobeIcon';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import { parseProviderIcon } from '@/lib/providerIconCodec';

const SHUAI_API_LOGO_URL = 'https://api.shuaiapi.com/images/logo.svg';
const GPTNB_LOGO_URL = 'https://pic.scdn.app/images/2023/06/26/favicon.png';
const NEW_API_LOGO_URL =
  'https://cdn.jsdelivr.net/gh/QuantumNous/new-api@main/web/public/logo.png';

const BUILTIN_LOGO_URLS: Record<string, string> = {
  shuaiapi: SHUAI_API_LOGO_URL,
  gptnb: GPTNB_LOGO_URL,
  newapi: NEW_API_LOGO_URL,
};

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
  bedrock: 'bedrock',
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

/**
 * Whether @lobehub/icons ModelIcon would resolve a brand icon for this model id
 * (as opposed to its generic Brain DefaultAvatar).
 *
 * ModelIcon only matches model_id keywords — e.g. Cohere maps to `command`,
 * Voyage to `voyage`. IDs like `rerank-v4.0` / `rerank-2.5` do not match and
 * fall through to the default avatar.
 */
export function hasKnownModelIcon(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase().replace(/\s+/g, '');
  if (!normalized) return false;
  return findModelKey(normalized) != null;
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

function ProviderFileIcon({
  value,
  size,
  shape,
}: {
  value: string;
  size: number;
  shape?: 'circle' | 'square';
}) {
  const resolvedSrc = useResolvedAvatarSrc('file', value);
  const direct =
    value.slice(0, 64).toLowerCase().startsWith('data:image/')
    || value.startsWith('aqbot-media://')
    || value.includes('aqbot-media.localhost');
  const src = resolvedSrc ?? (direct ? value : undefined);
  return (
    <Avatar
      size={size}
      src={src}
      shape={shape === 'square' ? 'square' : 'circle'}
      style={{ flexShrink: 0 }}
    />
  );
}

/**
 * Two-tier icon component: tries custom icon, then ProviderIcon/ModelIcon fallback.
 * Custom provider.icon may be emoji/url/file (prefixed) or a lobe model/provider key.
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
  const parsed = parseProviderIcon(provider.icon);
  if (parsed) {
    if (parsed.type === 'emoji') {
      const borderRadius = shape === 'square' ? Math.floor(size * 0.1) : '50%';
      return (
        <div
          style={{
            width: size,
            height: size,
            borderRadius,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size * 0.55,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {parsed.value}
        </div>
      );
    }
    if (parsed.type === 'url') {
      return (
        <Avatar
          size={size}
          src={parsed.value}
          shape={shape === 'square' ? 'square' : 'circle'}
          style={{ flexShrink: 0 }}
        />
      );
    }
    if (parsed.type === 'file') {
      return <ProviderFileIcon value={parsed.value} size={size} shape={shape} />;
    }
    // model_icon: value is `group:id` or bare id
    const iconId = parsed.value.includes(':')
      ? parsed.value.slice(parsed.value.indexOf(':') + 1)
      : parsed.value;
    return <DynamicLobeIcon iconId={iconId} size={size} type={type} />;
  }
  const builtinLogoUrl = provider.builtin_id
    ? BUILTIN_LOGO_URLS[provider.builtin_id]
    : undefined;
  if (builtinLogoUrl) {
    const borderRadius = shape === 'circle' || (shape === undefined && type === 'avatar')
      ? '50%'
      : shape === 'square'
        ? Math.floor(size * 0.1)
        : undefined;
    return (
      <img
        alt=""
        height={size}
        src={builtinLogoUrl}
        style={{
          borderRadius,
          display: 'block',
          flex: 'none',
          objectFit: 'contain',
        }}
        width={size}
      />
    );
  }
  const result = resolveProviderIcon(provider);
  if (result.type === 'model') {
    return <ModelIcon model={result.key} size={size} type={type} />;
  }
  return <ProviderIcon provider={result.key} size={size} type={type} shape={shape} />;
}, (prev, next) =>
  prev.provider.icon === next.provider.icon
  && prev.provider.builtin_id === next.provider.builtin_id
  && prev.provider.name === next.provider.name
  && prev.provider.provider_type === next.provider.provider_type
  && prev.size === next.size
  && prev.type === next.type
  && prev.shape === next.shape
);

/**
 * Model avatar with provider fallback.
 *
 * 1) Known model brand (e.g. gpt-4o, jina-*, command-*) → ModelIcon
 * 2) Unknown model id but provider is known → SmartProviderIcon
 *    (Cohere `rerank-v4.0`, Voyage `rerank-2.5`, custom endpoints, …)
 * 3) No provider → ModelIcon default avatar
 */
export const SmartModelIcon = memo(function SmartModelIcon({
  modelId,
  provider,
  size = 20,
  type = 'avatar',
  shape,
}: {
  modelId: string;
  provider?: ProviderConfig | null;
  size?: number;
  type?: 'avatar' | 'color' | 'mono';
  shape?: 'circle' | 'square';
}) {
  if (hasKnownModelIcon(modelId)) {
    return <ModelIcon model={modelId} size={size} type={type} />;
  }
  if (provider) {
    return <SmartProviderIcon provider={provider} size={size} type={type} shape={shape} />;
  }
  return <ModelIcon model={modelId} size={size} type={type} />;
}, (prev, next) =>
  prev.modelId === next.modelId
  && prev.provider?.id === next.provider?.id
  && prev.provider?.icon === next.provider?.icon
  && prev.provider?.builtin_id === next.provider?.builtin_id
  && prev.provider?.name === next.provider?.name
  && prev.provider?.provider_type === next.provider?.provider_type
  && prev.size === next.size
  && prev.type === next.type
  && prev.shape === next.shape
);
