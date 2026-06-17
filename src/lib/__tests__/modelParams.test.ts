import { describe, expect, it } from 'vitest';
import { resolveModelParamDefaults } from '../modelParams';
import type { AppSettings, Model } from '@/types';

type ModelForDefaults = Pick<Model, 'param_overrides'>;
type SettingsForDefaults = Pick<
  AppSettings,
  | 'default_temperature'
  | 'default_top_p'
  | 'default_max_tokens'
  | 'default_frequency_penalty'
>;

function modelWithOverrides(overrides: Model['param_overrides']): ModelForDefaults {
  return { param_overrides: overrides };
}

const globalDefaults: SettingsForDefaults = {
  default_temperature: 0.9,
  default_top_p: 0.95,
  default_max_tokens: 32768,
  default_frequency_penalty: 1.2,
};

describe('resolveModelParamDefaults', () => {
  it('prefers selected model sampling params but not model max token presets', () => {
    const defaults = resolveModelParamDefaults(
      modelWithOverrides({
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 4096,
        frequency_penalty: 0.4,
      }),
      globalDefaults,
    );

    expect(defaults).toEqual({
      temperature: 0.2,
      topP: 0.8,
      maxTokens: 32768,
      frequencyPenalty: 0.4,
    });
  });

  it('falls back to global defaults and then built-in defaults', () => {
    expect(resolveModelParamDefaults(modelWithOverrides(null), globalDefaults)).toEqual({
      temperature: 0.9,
      topP: 0.95,
      maxTokens: 32768,
      frequencyPenalty: 1.2,
    });

    expect(resolveModelParamDefaults(null, null)).toEqual({
      temperature: 0.7,
      topP: 1,
      maxTokens: 4096,
      frequencyPenalty: 0,
    });
  });
});
