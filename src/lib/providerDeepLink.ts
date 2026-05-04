import type { ProviderType } from '@/types';

export interface ProviderDeepLinkPayload {
  name: string;
  baseurl: string;
  apikey: string;
  type: ProviderType;
}

const PROVIDER_TYPES: ProviderType[] = [
  'openai',
  'openai_responses',
  'deepseek',
  'xai',
  'glm',
  'siliconflow',
  'anthropic',
  'gemini',
  'jina',
  'cohere',
  'voyage',
  'custom',
];

function readRequiredParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim();
  return value ? value : null;
}

function isProviderType(value: string): value is ProviderType {
  return PROVIDER_TYPES.includes(value as ProviderType);
}

function getDeepLinkTarget(url: URL): string {
  if (url.hostname) return url.hostname;
  return url.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
}

export function parseProviderDeepLink(rawUrl: string): ProviderDeepLinkPayload | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'aqbot:') return null;
  if (getDeepLinkTarget(url) !== 'providers') return null;

  const name = readRequiredParam(url.searchParams, 'name');
  const baseurl = readRequiredParam(url.searchParams, 'baseurl');
  const apikey = readRequiredParam(url.searchParams, 'apikey');
  const type = readRequiredParam(url.searchParams, 'type');

  if (!name || !baseurl || !apikey || !type || !isProviderType(type)) {
    return null;
  }

  return { name, baseurl, apikey, type };
}

export function getProviderDeepLinkKeyPrefix(apikey: string): string {
  return apikey.length >= 8 ? `${apikey.slice(0, 8)}...` : apikey;
}
