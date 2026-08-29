import type {
  BedrockCredentialInput,
  ModelCapability,
  ModelMetadataState,
  ModelParamOverrides,
  ModelType,
  ProviderType,
} from '@/types';
import type { ModelMetadataField } from './ModelMetadataSyncModal';

export function metadataStateWithAutomaticFields(
  current: ModelMetadataState | null | undefined,
  automatic: ModelMetadataState | null | undefined,
  fields: ModelMetadataField[],
): ModelMetadataState | null {
  if (!automatic || fields.length === 0) return current ?? null;
  const next: ModelMetadataState = current
    ? { ...current }
    : {
        schema_version: automatic.schema_version,
        catalog_key: null,
        catalog_mode: null,
        model_type: 'user',
        capabilities: 'user',
        context_window: 'user',
        max_output_tokens: 'user',
        no_system_role: 'user',
        omit_sampling_params: 'user',
        reasoning_options: 'user',
      };
  next.schema_version = automatic.schema_version;
  if (automatic.catalog_key) {
    next.catalog_key = automatic.catalog_key;
  }
  if (automatic.catalog_mode) {
    next.catalog_mode = automatic.catalog_mode;
  }
  for (const field of fields) {
    next[field] = automatic[field];
  }
  return next;
}

export function sameCapabilities(left: ModelCapability[], right: ModelCapability[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

export function hasUserMetadata(state: ModelMetadataState | null | undefined): boolean {
  return state
    ? [
        state.model_type,
        state.capabilities,
        state.context_window,
        state.max_output_tokens,
        state.no_system_role,
        state.omit_sampling_params,
        state.reasoning_options,
      ].includes('user')
    : true;
}

export function metadataStateWithUserFields(
  current: ModelMetadataState | null | undefined,
  fields: Set<ModelMetadataField>,
): ModelMetadataState | null {
  if (!current || fields.size === 0) return current ?? null;
  const next = { ...current };
  fields.forEach((field) => {
    next[field] = 'user';
  });
  return next;
}

export const DEFAULT_PATHS: Record<ProviderType, string> = {
  openai: '/v1/chat/completions',
  openai_responses: '/v1/responses',
  deepseek: '/v1/chat/completions',
  xai: '/v1/chat/completions',
  glm: '/v4/chat/completions',
  siliconflow: '/v1/chat/completions',
  anthropic: '/v1/messages',
  gemini: '/v1beta/models',
  jina: '/v1/rerank',
  cohere: '/v2/rerank',
  voyage: '/v1/rerank',
  bedrock: '',
  custom: '/v1/chat/completions',
};

export const DEFAULT_HOSTS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com',
  openai_responses: 'https://api.openai.com',
  deepseek: 'https://api.deepseek.com',
  xai: 'https://api.x.ai',
  glm: 'https://open.bigmodel.cn/api/paas',
  siliconflow: 'https://api.siliconflow.cn',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  jina: 'https://api.jina.ai',
  cohere: 'https://api.cohere.com',
  voyage: 'https://api.voyageai.com',
  bedrock: '',
  custom: '',
};

const EMPTY_HOST_BUILTINS = new Set(['newapi']);

export function getProviderDefaultHost(provider: {
  builtin_id?: string | null;
  provider_type: ProviderType;
}): string {
  if (provider.builtin_id && EMPTY_HOST_BUILTINS.has(provider.builtin_id)) {
    return '';
  }
  return DEFAULT_HOSTS[provider.provider_type] ?? '';
}

export const DEFAULT_VERSIONS: Record<ProviderType, string> = {
  openai: '/v1',
  openai_responses: '/v1',
  deepseek: '/v1',
  xai: '/v1',
  glm: '/v4',
  siliconflow: '/v1',
  anthropic: '/v1',
  gemini: '/v1beta',
  jina: '/v1',
  cohere: '/v2',
  voyage: '/v1',
  bedrock: '',
  custom: '/v1',
};

export const AWS_REGION_OPTIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-southeast-1',
  'ap-southeast-2',
].map((value) => ({ value }));

export const EMPTY_BEDROCK_CREDENTIALS: BedrockCredentialInput = {
  access_key_id: '',
  secret_access_key: '',
  session_token: '',
};

export const REASONING_PROFILE_OPTIONS = [
  { value: 'reasoning_effort', label: '自动匹配（推荐）' },
  { value: 'openai_reasoning_effort', label: 'OpenAI Chat' },
  { value: 'openai_responses_reasoning', label: 'OpenAI Responses' },
  { value: 'glm_thinking', label: 'GLM thinking' },
  { value: 'gemini_thinking_level', label: 'Gemini thinkingLevel' },
  { value: 'gemini_thinking_budget', label: 'Gemini thinkingBudget' },
  { value: 'anthropic_adaptive', label: 'Claude adaptive' },
  { value: 'anthropic_budget_tokens', label: 'Claude budget_tokens' },
  { value: 'enable_thinking', label: 'SiliconFlow enable_thinking' },
  { value: 'none', label: 'none' },
];

export const REASONING_PROFILE_SELECT_WIDTH = 260;
export const REASONING_PROFILE_POPUP_WIDTH = 320;

export function normalizeReasoningProfile(value: string): string | undefined {
  return value === 'reasoning_effort' ? undefined : value;
}

const RESERVED_EXTRA_BODY_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'tools',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
]);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatExtraBody(extraBody: ModelParamOverrides['extra_body']): string {
  if (!extraBody || Object.keys(extraBody).length === 0) return '';
  return JSON.stringify(extraBody, null, 2);
}

export function parseExtraBodyInput(text: string): { value?: Record<string, unknown>; errorKey?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { errorKey: 'settings.extraBodyJsonError' };
  }

  if (!isJsonObject(parsed)) {
    return { errorKey: 'settings.extraBodyObjectError' };
  }

  const reservedField = Object.keys(parsed).find((key) => RESERVED_EXTRA_BODY_FIELDS.has(key));
  if (reservedField) {
    return { errorKey: 'settings.extraBodyReservedError' };
  }

  return Object.keys(parsed).length > 0 ? { value: parsed } : {};
}

export function getDefaultCapabilitiesForType(modelType: ModelType): ModelCapability[] {
  switch (modelType) {
    case 'Voice':
      return ['RealtimeVoice'];
    case 'Embedding':
    case 'Image':
    case 'Rerank':
      return [];
    case 'Chat':
    default:
      return ['TextChat'];
  }
}
