import type { Model, ProviderType } from '@/types';

export type ReasoningOptionKey =
  | 'default'
  | 'off'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type ReasoningApiStyle =
  | 'none'
  | 'openai_reasoning_effort'
  | 'openai_responses_reasoning'
  | 'glm_thinking'
  | 'gemini_thinking_level'
  | 'gemini_thinking_budget'
  | 'anthropic_adaptive'
  | 'anthropic_budget_tokens'
  | 'siliconflow_enable_thinking';

export interface ReasoningOption {
  key: ReasoningOptionKey;
  labelKey: string;
  fallbackLabel: string;
  icon: 'default' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reasoningEffort?: string;
  thinkingLevel?: string;
  budgetTokens?: number;
  enableThinking?: boolean;
}

export interface ReasoningProfile {
  apiStyle: ReasoningApiStyle;
  options: ReasoningOption[];
  defaultOptionKey: ReasoningOptionKey;
}

export interface ResolvedReasoningRequest {
  level: ReasoningOptionKey;
  apiStyle: ReasoningApiStyle;
  reasoningEffort?: string;
  thinkingLevel?: string;
  budgetTokens?: number;
  enableThinking?: boolean;
  suppressSamplingParams: boolean;
}

const OPTION_DEFS: Record<ReasoningOptionKey, ReasoningOption> = {
  default: {
    key: 'default',
    labelKey: 'chat.thinking.default',
    fallbackLabel: '默认',
    icon: 'default',
  },
  off: {
    key: 'off',
    labelKey: 'chat.thinking.off',
    fallbackLabel: '关闭',
    icon: 'off',
    reasoningEffort: 'off',
    enableThinking: false,
  },
  none: {
    key: 'none',
    labelKey: 'chat.thinking.none',
    fallbackLabel: '禁止思考',
    icon: 'off',
    reasoningEffort: 'none',
    enableThinking: false,
    budgetTokens: 0,
  },
  minimal: {
    key: 'minimal',
    labelKey: 'chat.thinking.minimal',
    fallbackLabel: 'Minimal',
    icon: 'low',
    thinkingLevel: 'minimal',
  },
  low: {
    key: 'low',
    labelKey: 'chat.thinking.low',
    fallbackLabel: 'Low',
    icon: 'low',
    reasoningEffort: 'low',
    thinkingLevel: 'low',
    budgetTokens: 1024,
    enableThinking: true,
  },
  medium: {
    key: 'medium',
    labelKey: 'chat.thinking.medium',
    fallbackLabel: 'Medium',
    icon: 'medium',
    reasoningEffort: 'medium',
    thinkingLevel: 'medium',
    budgetTokens: 4096,
    enableThinking: true,
  },
  high: {
    key: 'high',
    labelKey: 'chat.thinking.high',
    fallbackLabel: 'High',
    icon: 'high',
    reasoningEffort: 'high',
    thinkingLevel: 'high',
    budgetTokens: 8192,
    enableThinking: true,
  },
  xhigh: {
    key: 'xhigh',
    labelKey: 'chat.thinking.xhigh',
    fallbackLabel: 'XHigh',
    icon: 'xhigh',
    reasoningEffort: 'xhigh',
    thinkingLevel: 'xhigh',
    budgetTokens: 16384,
    enableThinking: true,
  },
  max: {
    key: 'max',
    labelKey: 'chat.thinking.max',
    fallbackLabel: 'Max',
    icon: 'max',
    reasoningEffort: 'max',
    thinkingLevel: 'max',
    budgetTokens: 32768,
    enableThinking: true,
  },
};

const OPTION_ORDER = Object.keys(OPTION_DEFS) as ReasoningOptionKey[];

// Every level each request style can carry; custom model whitelists may pick from these.
const STYLE_OPTION_KEYS: Record<ReasoningApiStyle, ReasoningOptionKey[]> = {
  none: [],
  openai_reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  openai_responses_reasoning: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  glm_thinking: ['none', 'high'],
  gemini_thinking_level: ['minimal', 'low', 'medium', 'high'],
  gemini_thinking_budget: ['none', 'low', 'medium', 'high', 'xhigh'],
  anthropic_adaptive: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  anthropic_budget_tokens: ['low', 'medium', 'high', 'xhigh', 'max'],
  siliconflow_enable_thinking: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};

function options(keys: ReasoningOptionKey[]): ReasoningOption[] {
  return keys.map((key) => ({ ...OPTION_DEFS[key] }));
}

// Aggregators expose ids like `openai/gpt-5.6-sol` or `gpt-5.6:free`; match families on the bare name.
function baseModelId(model: Pick<Model, 'model_id'> | null | undefined): string {
  const modelId = model?.model_id.toLowerCase() ?? '';
  return modelId.slice(modelId.lastIndexOf('/') + 1).replace(/^ft:/, '').split(':')[0];
}

function normalizedModelId(modelId: string): string {
  return modelId.replace(/[_\s]+/g, '-');
}

function isOpenAiModelId(modelId: string): boolean {
  return modelId.startsWith('gpt-') || modelId.startsWith('o');
}

const GPT_56_MODEL_PATTERN = /^gpt-5\.6(?:$|-)/;

function overrideProfile(model: Pick<Model, 'param_overrides'> | null | undefined): ReasoningApiStyle | null {
  const profile = model?.param_overrides?.reasoning_profile;
  if (!profile) return null;
  // Legacy alias still written by the model settings UI; the backend maps it the same way.
  if (profile === 'enable_thinking') return 'siliconflow_enable_thinking';
  return Object.prototype.hasOwnProperty.call(STYLE_OPTION_KEYS, profile)
    ? (profile as ReasoningApiStyle)
    : null;
}

export function isCustomReasoningOptions(
  model: Pick<Model, 'param_overrides' | 'metadata_state'> | null | undefined,
): boolean {
  return model?.metadata_state?.reasoning_options === 'user'
    && (model.param_overrides?.reasoning_options?.length ?? 0) > 0;
}

export function reasoningOptionUniverse(profile: ReasoningProfile): ReasoningOption[] {
  const keys = new Set<ReasoningOptionKey>([
    'default',
    ...profile.options.map((option) => option.key),
    ...STYLE_OPTION_KEYS[profile.apiStyle],
  ]);
  return options(OPTION_ORDER.filter((key) => keys.has(key)));
}

function openAiProfile(
  providerType: ProviderType,
  modelId: string,
  supportsMax = GPT_56_MODEL_PATTERN.test(modelId),
): ReasoningProfile {
  const apiStyle = providerType === 'openai_responses'
    ? 'openai_responses_reasoning'
    : 'openai_reasoning_effort';
  const supportsXHigh = modelId.startsWith('gpt-5') || modelId.startsWith('o5');
  return {
    apiStyle,
    defaultOptionKey: 'default',
    options: options(
      supportsMax
        ? ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']
        : supportsXHigh
          ? ['default', 'none', 'low', 'medium', 'high', 'xhigh']
          : ['default', 'none', 'low', 'medium', 'high'],
    ),
  };
}

function geminiProfile(modelId: string): ReasoningProfile {
  const isGemini3 = modelId.includes('3.') || modelId.includes('gemini-3') || modelId.includes('-3-');
  if (isGemini3) {
    return {
      apiStyle: 'gemini_thinking_level',
      defaultOptionKey: 'default',
      options: options(modelId.includes('pro')
        ? ['default', 'low', 'medium', 'high']
        : ['default', 'minimal', 'low', 'medium', 'high']),
    };
  }

  return {
    apiStyle: 'gemini_thinking_budget',
    defaultOptionKey: 'default',
    options: options(['default', 'none', 'low', 'medium', 'high']),
  };
}

function anthropicProfile(modelId: string): ReasoningProfile {
  if (modelId.includes('4.7') || modelId.includes('4-7')) {
    return {
      apiStyle: 'anthropic_adaptive',
      defaultOptionKey: 'default',
      options: options(['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max']),
    };
  }
  if (modelId.includes('4.6') || modelId.includes('4-6')) {
    return {
      apiStyle: 'anthropic_adaptive',
      defaultOptionKey: 'default',
      options: options(['default', 'off', 'low', 'medium', 'high', 'max']),
    };
  }
  return {
    apiStyle: 'anthropic_budget_tokens',
    defaultOptionKey: 'default',
    options: options(['default', 'none', 'low', 'medium', 'high']),
  };
}

function deepSeekProfile(): ReasoningProfile {
  return {
    apiStyle: 'openai_reasoning_effort',
    defaultOptionKey: 'default',
    options: options(['default', 'none', 'high', 'max']),
  };
}

function xaiProfile(modelId: string): ReasoningProfile {
  if (modelId.startsWith('grok-4.3')) {
    return {
      apiStyle: 'openai_reasoning_effort',
      defaultOptionKey: 'default',
      options: options(['default', 'none', 'low', 'medium', 'high']),
    };
  }
  return { apiStyle: 'none', defaultOptionKey: 'default', options: options(['default']) };
}

function glmProfile(): ReasoningProfile {
  return {
    apiStyle: 'glm_thinking',
    defaultOptionKey: 'default',
    options: options(['default', 'none', 'high']),
  };
}

function siliconFlowProfile(): ReasoningProfile {
  return {
    apiStyle: 'siliconflow_enable_thinking',
    defaultOptionKey: 'default',
    options: options(['default', 'none', 'low', 'medium', 'high']),
  };
}

function overriddenProfile(
  apiStyle: ReasoningApiStyle,
  modelId: string,
  supportsGpt56Max: boolean,
): ReasoningProfile {
  if (apiStyle === 'glm_thinking') return glmProfile();
  if (apiStyle === 'anthropic_budget_tokens') {
    return {
      apiStyle,
      defaultOptionKey: 'default',
      options: options(modelId.includes('4.7') || modelId.includes('4-7')
        ? ['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max']
        : ['default', 'off', 'low', 'medium', 'high', 'max']),
    };
  }
  if (apiStyle === 'siliconflow_enable_thinking') {
    return {
      apiStyle,
      defaultOptionKey: 'default',
      options: options(['default', 'none', 'low', 'medium', 'high']),
    };
  }
  if (apiStyle === 'none') {
    return { apiStyle, defaultOptionKey: 'default', options: options(['default']) };
  }
  if (apiStyle === 'gemini_thinking_level') return geminiProfile('gemini-3.1-flash');
  if (apiStyle === 'gemini_thinking_budget') return geminiProfile('gemini-2.5-pro');
  if (apiStyle === 'anthropic_adaptive') return anthropicProfile(modelId);
  return openAiProfile(
    apiStyle === 'openai_responses_reasoning' ? 'openai_responses' : 'openai',
    modelId,
    supportsGpt56Max,
  );
}

export function resolveReasoningProfile(
  providerType: ProviderType | undefined,
  model: Model | null | undefined,
): ReasoningProfile {
  const baseId = baseModelId(model);
  const modelId = normalizedModelId(baseId);
  const supportsGpt56Max = GPT_56_MODEL_PATTERN.test(baseId);
  const explicitProfile = overrideProfile(model);
  let profile: ReasoningProfile;
  if (explicitProfile) profile = overriddenProfile(explicitProfile, modelId, supportsGpt56Max);
  else if (providerType === 'gemini') profile = geminiProfile(modelId);
  else if (providerType === 'anthropic') profile = anthropicProfile(modelId);
  else if (providerType === 'deepseek') profile = deepSeekProfile();
  else if (providerType === 'xai') profile = xaiProfile(modelId);
  else if (providerType === 'glm') profile = glmProfile();
  else if (providerType === 'siliconflow') profile = siliconFlowProfile();
  else if (providerType === 'openai' || providerType === 'openai_responses') {
    profile = openAiProfile(providerType, modelId, supportsGpt56Max);
  }
  else if (modelId.includes('claude')) profile = anthropicProfile(modelId);
  else if (modelId.includes('gemini')) profile = geminiProfile(modelId);
  else if (
    isOpenAiModelId(modelId)
    // Keep prefixed ids such as `openai/chatgpt-4o-latest` on the OpenAI profile they always had.
    || isOpenAiModelId(normalizedModelId(model?.model_id.toLowerCase() ?? ''))
  ) {
    profile = openAiProfile('openai', modelId, supportsGpt56Max);
  }
  else profile = { apiStyle: 'none', defaultOptionKey: 'default', options: options(['default']) };

  const allowed = model?.param_overrides?.reasoning_options;
  if (!allowed?.length) return profile;
  const allowedKeys = new Set<ReasoningOptionKey>(
    allowed.filter((key): key is ReasoningOptionKey => key in OPTION_DEFS),
  );
  allowedKeys.add('default');
  let filteredOptions: ReasoningOption[];
  if (isCustomReasoningOptions(model)) {
    // User whitelists may go beyond the inferred levels, within what the request style can carry.
    filteredOptions = reasoningOptionUniverse(profile).filter((option) => allowedKeys.has(option.key));
    // A whitelist written for another request style no longer applies; fall back to inference.
    if (filteredOptions.length <= 1) return profile;
  } else {
    if (
      supportsGpt56Max
      && model?.metadata_state?.reasoning_options === 'catalog'
      && (
        profile.apiStyle === 'openai_reasoning_effort'
        || profile.apiStyle === 'openai_responses_reasoning'
      )
    ) {
      profile.options.forEach((option) => allowedKeys.add(option.key));
    }
    filteredOptions = profile.options.filter((option) => allowedKeys.has(option.key));
  }
  const defaultOptionKey = allowedKeys.has(
    model?.param_overrides?.reasoning_default as ReasoningOptionKey,
  )
    ? model!.param_overrides!.reasoning_default as ReasoningOptionKey
    : 'default';
  return {
    ...profile,
    options: filteredOptions.length > 0 ? filteredOptions : options(['default']),
    defaultOptionKey,
  };
}

export function coerceReasoningOptionKey(
  profile: ReasoningProfile,
  key: string | null | undefined,
): ReasoningOptionKey {
  if (!key) return profile.defaultOptionKey;
  return profile.options.some((option) => option.key === key)
    ? (key as ReasoningOptionKey)
    : profile.defaultOptionKey;
}

export function legacyThinkingBudgetToOptionKey(
  profile: ReasoningProfile,
  budget: number | null | undefined,
): ReasoningOptionKey | null {
  if (budget === null || budget === undefined) return null;
  if (budget === 0) return coerceReasoningOptionKey(profile, profile.apiStyle.includes('anthropic') ? 'off' : 'none');
  if (budget <= 2048) return coerceReasoningOptionKey(profile, 'low');
  if (budget <= 6144) return coerceReasoningOptionKey(profile, 'medium');
  if (budget <= 12288) return coerceReasoningOptionKey(profile, 'high');
  return coerceReasoningOptionKey(profile, 'xhigh');
}

export function resolveReasoningRequest(
  profile: ReasoningProfile,
  key: string | null | undefined,
): ResolvedReasoningRequest | undefined {
  const optionKey = coerceReasoningOptionKey(profile, key);
  if (optionKey === 'default' || profile.apiStyle === 'none') return undefined;

  const option = profile.options.find((item) => item.key === optionKey) ?? OPTION_DEFS[optionKey];
  const suppressSamplingParams = optionKey !== 'off' && optionKey !== 'none';

  if (profile.apiStyle === 'gemini_thinking_level') {
    return {
      level: optionKey,
      apiStyle: profile.apiStyle,
      thinkingLevel: option.thinkingLevel,
      suppressSamplingParams: false,
    };
  }

  if (profile.apiStyle === 'glm_thinking') {
    return {
      level: optionKey,
      apiStyle: profile.apiStyle,
      suppressSamplingParams,
    };
  }

  if (profile.apiStyle === 'gemini_thinking_budget' || profile.apiStyle === 'anthropic_budget_tokens') {
    return {
      level: optionKey,
      apiStyle: profile.apiStyle,
      budgetTokens: optionKey === 'off' || optionKey === 'none' ? 0 : option.budgetTokens,
      suppressSamplingParams,
    };
  }

  if (profile.apiStyle === 'siliconflow_enable_thinking') {
    return {
      level: optionKey,
      apiStyle: profile.apiStyle,
      enableThinking: option.enableThinking,
      budgetTokens: option.budgetTokens,
      suppressSamplingParams,
    };
  }

  return {
    level: optionKey,
    apiStyle: profile.apiStyle,
    reasoningEffort: option.reasoningEffort,
    suppressSamplingParams,
  };
}
