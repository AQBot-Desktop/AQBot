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

function options(keys: ReasoningOptionKey[]): ReasoningOption[] {
  return keys.map((key) => ({ ...OPTION_DEFS[key] }));
}

function normalizedModelId(model: Pick<Model, 'model_id'> | null | undefined): string {
  return model?.model_id.toLowerCase().replace(/[_\s]+/g, '-') ?? '';
}

function overrideProfile(model: Pick<Model, 'param_overrides'> | null | undefined): ReasoningApiStyle | null {
  const profile = model?.param_overrides?.reasoning_profile;
  if (!profile) return null;
  return [
    'none',
    'openai_reasoning_effort',
    'openai_responses_reasoning',
    'gemini_thinking_level',
    'gemini_thinking_budget',
    'anthropic_adaptive',
    'anthropic_budget_tokens',
    'siliconflow_enable_thinking',
  ].includes(profile) ? (profile as ReasoningApiStyle) : null;
}

function openAiProfile(providerType: ProviderType, modelId: string): ReasoningProfile {
  const apiStyle = providerType === 'openai_responses'
    ? 'openai_responses_reasoning'
    : 'openai_reasoning_effort';
  const supportsXHigh = modelId.startsWith('gpt-5') || modelId.startsWith('o5');
  return {
    apiStyle,
    defaultOptionKey: 'default',
    options: options(supportsXHigh
      ? ['default', 'none', 'low', 'medium', 'high', 'xhigh']
      : ['default', 'none', 'low', 'medium', 'high']),
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

function overriddenProfile(apiStyle: ReasoningApiStyle, modelId: string): ReasoningProfile {
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
  return openAiProfile(apiStyle === 'openai_responses_reasoning' ? 'openai_responses' : 'openai', modelId);
}

export function resolveReasoningProfile(
  providerType: ProviderType | undefined,
  model: Model | null | undefined,
): ReasoningProfile {
  const modelId = normalizedModelId(model);
  const explicitProfile = overrideProfile(model);
  if (explicitProfile) return overriddenProfile(explicitProfile, modelId);

  if (providerType === 'gemini') return geminiProfile(modelId);
  if (providerType === 'anthropic') return anthropicProfile(modelId);
  if (providerType === 'openai' || providerType === 'openai_responses') return openAiProfile(providerType, modelId);

  if (modelId.includes('claude')) return anthropicProfile(modelId);
  if (modelId.includes('gemini')) return geminiProfile(modelId);
  if (modelId.startsWith('gpt-') || modelId.startsWith('o')) return openAiProfile('openai', modelId);

  return { apiStyle: 'none', defaultOptionKey: 'default', options: options(['default']) };
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
