import type { AppSettings, Model } from '@/types';

type ModelForDefaults = Pick<Model, 'param_overrides'> | null | undefined;
type SettingsForDefaults = Pick<
  AppSettings,
  | 'default_temperature'
  | 'default_top_p'
  | 'default_max_tokens'
  | 'default_frequency_penalty'
> | null | undefined;

export interface ResolvedModelParamDefaults {
  temperature: number;
  topP: number;
  maxTokens: number;
  frequencyPenalty: number;
}

export function resolveModelParamDefaults(
  model: ModelForDefaults,
  settings: SettingsForDefaults,
): ResolvedModelParamDefaults {
  return {
    temperature: model?.param_overrides?.temperature ?? settings?.default_temperature ?? 0.7,
    topP: model?.param_overrides?.top_p ?? settings?.default_top_p ?? 1,
    maxTokens: settings?.default_max_tokens ?? 4096,
    frequencyPenalty: model?.param_overrides?.frequency_penalty ?? settings?.default_frequency_penalty ?? 0,
  };
}
