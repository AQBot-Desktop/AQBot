import { describe, expect, it } from 'vitest';
import {
  isCustomReasoningOptions,
  reasoningOptionUniverse,
  resolveReasoningProfile,
  resolveReasoningRequest,
} from '../reasoningProfile';
import type { Model, ModelMetadataSource, ProviderType } from '@/types';

function metadataState(reasoningOptions: ModelMetadataSource): NonNullable<Model['metadata_state']> {
  return {
    schema_version: 1,
    catalog_key: null,
    catalog_mode: null,
    model_type: 'default',
    capabilities: 'default',
    context_window: 'default',
    max_output_tokens: 'default',
    no_system_role: 'default',
    omit_sampling_params: 'default',
    reasoning_options: reasoningOptions,
  };
}

function model(
  modelId: string,
  overrides: Model['param_overrides'] = null,
  reasoningOptionsSource?: ModelMetadataSource,
): Model {
  return {
    provider_id: 'provider-1',
    model_id: modelId,
    name: modelId,
    model_type: 'Chat',
    capabilities: ['Reasoning'],
    context_window: 128000,
    enabled: true,
    param_overrides: overrides,
    metadata_state: reasoningOptionsSource ? metadataState(reasoningOptionsSource) : null,
  };
}

function optionKeys(providerType: ProviderType, modelId: string, overrides: Model['param_overrides'] = null) {
  return resolveReasoningProfile(providerType, model(modelId, overrides)).options.map((option) => option.key);
}

describe('reasoning profile resolution', () => {
  it('uses OpenAI reasoning effort options for GPT-5 models', () => {
    const profile = resolveReasoningProfile('openai', model('gpt-5.1'));

    expect(profile.apiStyle).toBe('openai_reasoning_effort');
    expect(profile.options.map((option) => option.key)).toEqual(['default', 'none', 'low', 'medium', 'high', 'xhigh']);
    expect(resolveReasoningRequest(profile, 'xhigh')).toEqual({
      level: 'xhigh',
      apiStyle: 'openai_reasoning_effort',
      reasoningEffort: 'xhigh',
      suppressSamplingParams: true,
    });
  });

  it('exposes every supported reasoning effort for the GPT-5.6 family only', () => {
    const expected = ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];

    for (const providerType of ['openai', 'openai_responses'] as const) {
      for (const modelId of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
        expect(optionKeys(providerType, modelId), `${providerType}/${modelId}`).toEqual(expected);
      }
    }

    expect(optionKeys('openai', 'gpt-5.5')).toEqual([
      'default',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(optionKeys('openai', 'gpt-5.60')).not.toContain('max');
    expect(optionKeys('openai', 'gpt-5.6_preview')).not.toContain('max');

    const profile = resolveReasoningProfile('openai', model('gpt-5.6-sol'));
    expect(resolveReasoningRequest(profile, 'max')).toMatchObject({
      level: 'max',
      apiStyle: 'openai_reasoning_effort',
      reasoningEffort: 'max',
    });
  });

  it('matches model families behind aggregator vendor prefixes and routing tags', () => {
    const complete = ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];

    expect(optionKeys('openai', 'openai/gpt-5.6-sol')).toEqual(complete);
    expect(optionKeys('openai_responses', 'openrouter/openai/gpt-5.6:free')).toEqual(complete);
    expect(optionKeys('openai', 'OpenAI/GPT-5.6-Terra')).toEqual(complete);
    expect(optionKeys('openai', 'openai/gpt-5.5')).toEqual(['default', 'none', 'low', 'medium', 'high', 'xhigh']);
    expect(optionKeys('openai', 'ft:gpt-5.1:acme::abc123')).toContain('xhigh');
    expect(optionKeys('openai', 'openai/gpt-5.6_preview')).not.toContain('max');
    expect(optionKeys('custom', 'openai/gpt-5.6-sol')).toEqual(complete);
    expect(optionKeys('custom', 'anthropic/claude-opus-4.7')).toEqual(
      ['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max'],
    );
  });

  it('keeps prefixed custom models on the OpenAI profile they matched before', () => {
    for (const modelId of ['openai/chatgpt-4o-latest', 'openrouter/auto']) {
      const profile = resolveReasoningProfile('custom', model(modelId));
      expect(profile.apiStyle, modelId).toBe('openai_reasoning_effort');
      expect(profile.options.map((option) => option.key), modelId).toEqual(
        ['default', 'none', 'low', 'medium', 'high'],
      );
    }
  });

  it('lets a user whitelist add levels the request style supports', () => {
    const profile = resolveReasoningProfile(
      'openai',
      model('my-proxy-model', { reasoning_options: ['max', 'xhigh', 'low', 'unknown'] }, 'user'),
    );

    expect(profile.apiStyle).toBe('openai_reasoning_effort');
    expect(profile.options.map((option) => option.key)).toEqual(['default', 'low', 'xhigh', 'max']);
    expect(resolveReasoningRequest(profile, 'max')).toMatchObject({ reasoningEffort: 'max' });
  });

  it('keeps catalog and provider whitelists as filters over inferred levels', () => {
    for (const source of ['catalog', 'provider'] as const) {
      const profile = resolveReasoningProfile(
        'openai',
        model('gpt-4o', { reasoning_options: ['default', 'low', 'xhigh', 'max'] }, source),
      );

      expect(profile.options.map((option) => option.key), source).toEqual(['default', 'low']);
    }
  });

  it('limits user whitelists to levels the request style can carry', () => {
    const geminiLevel = resolveReasoningProfile(
      'gemini',
      model('gemini-3.1-flash', { reasoning_options: ['minimal', 'xhigh', 'max'] }, 'user'),
    );
    expect(geminiLevel.options.map((option) => option.key)).toEqual(['default', 'minimal']);

    const glm = resolveReasoningProfile(
      'glm',
      model('glm-4.6', { reasoning_options: ['low', 'medium'] }, 'user'),
    );
    expect(glm.options.map((option) => option.key)).toEqual(['default', 'none', 'high']);
  });

  it('keeps inferred none and off levels available for Claude budget tokens', () => {
    const inferred = resolveReasoningProfile('anthropic', model('claude-sonnet-4'));
    expect(reasoningOptionUniverse(inferred).map((option) => option.key)).toEqual(
      ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'],
    );

    const overridden = resolveReasoningProfile(
      'custom',
      model('claude-opus-4.6@vertex', { reasoning_profile: 'anthropic_budget_tokens' }),
    );
    expect(reasoningOptionUniverse(overridden).map((option) => option.key)).toEqual(
      ['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max'],
    );
  });

  it('treats only non-empty user-owned whitelists as custom', () => {
    expect(isCustomReasoningOptions(model('gpt-4o', { reasoning_options: ['high'] }, 'user'))).toBe(true);
    expect(isCustomReasoningOptions(model('gpt-4o', { reasoning_options: [] }, 'user'))).toBe(false);
    expect(isCustomReasoningOptions(model('gpt-4o', null, 'user'))).toBe(false);
    expect(isCustomReasoningOptions(model('gpt-4o', { reasoning_options: ['high'] }, 'catalog'))).toBe(false);
    expect(isCustomReasoningOptions(model('gpt-4o', { reasoning_options: ['high'] }))).toBe(false);
  });

  it('maps the legacy enable_thinking profile to SiliconFlow thinking', () => {
    const profile = resolveReasoningProfile(
      'openai',
      model('gpt-5.1', { reasoning_profile: 'enable_thinking' }),
    );

    expect(profile.apiStyle).toBe('siliconflow_enable_thinking');
    expect(profile.options.map((option) => option.key)).toEqual(['default', 'none', 'low', 'medium', 'high']);
  });

  it('repairs stale catalog reasoning options for GPT-5.6 models', () => {
    const profile = resolveReasoningProfile(
      'openai',
      model(
        'gpt-5.6-sol',
        {
          reasoning_options: ['default', 'none', 'medium', 'high', 'xhigh'],
          reasoning_default: 'medium',
        },
        'catalog',
      ),
    );

    expect(profile.options.map((option) => option.key)).toEqual([
      'default',
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(profile.defaultOptionKey).toBe('medium');
  });

  it('strictly respects user and provider reasoning option whitelists for GPT-5.6', () => {
    for (const source of ['user', 'provider'] as const) {
      const profile = resolveReasoningProfile(
        'openai_responses',
        model(
          'gpt-5.6-terra',
          { reasoning_options: ['default', 'none', 'high'] },
          source,
        ),
      );

      expect(profile.options.map((option) => option.key), source).toEqual([
        'default',
        'none',
        'high',
      ]);
    }
  });

  it('uses Gemini thinkingLevel options and removes minimal for 3.1 Pro', () => {
    expect(optionKeys('gemini', 'gemini-3.1-flash')).toEqual(['default', 'minimal', 'low', 'medium', 'high']);
    expect(optionKeys('gemini', 'gemini-3-flash-preview')).toEqual(['default', 'minimal', 'low', 'medium', 'high']);
    expect(optionKeys('gemini', 'gemini-3.1-pro')).toEqual(['default', 'low', 'medium', 'high']);

    const profile = resolveReasoningProfile('gemini', model('gemini-3.1-flash'));
    expect(resolveReasoningRequest(profile, 'minimal')).toMatchObject({
      level: 'minimal',
      apiStyle: 'gemini_thinking_level',
      thinkingLevel: 'minimal',
    });
  });

  it('uses Anthropic adaptive levels for direct Claude Opus model families', () => {
    expect(optionKeys('anthropic', 'claude-opus-4.6')).toEqual(['default', 'off', 'low', 'medium', 'high', 'max']);
    expect(optionKeys('anthropic', 'claude-opus-4.7')).toEqual(['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max']);

    const profile = resolveReasoningProfile('anthropic', model('claude-opus-4.7'));
    expect(resolveReasoningRequest(profile, 'max')).toMatchObject({
      level: 'max',
      apiStyle: 'anthropic_adaptive',
      reasoningEffort: 'max',
      suppressSamplingParams: true,
    });
  });

  it('lets model overrides force Vertex-compatible Claude budget tokens', () => {
    const profile = resolveReasoningProfile(
      'custom',
      model('claude-opus-4.7@vertex', { reasoning_profile: 'anthropic_budget_tokens' }),
    );

    expect(profile.apiStyle).toBe('anthropic_budget_tokens');
    expect(profile.options.map((option) => option.key)).toEqual(['default', 'off', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveReasoningRequest(profile, 'high')).toMatchObject({
      level: 'high',
      apiStyle: 'anthropic_budget_tokens',
      budgetTokens: 8192,
      suppressSamplingParams: true,
    });
  });

  it('ignores unknown reasoning profile overrides', () => {
    const profile = resolveReasoningProfile('gemini', model('gemini-3.1-flash', { reasoning_profile: 'unknown' }));

    expect(profile.apiStyle).toBe('gemini_thinking_level');
    expect(profile.options.map((option) => option.key)).toEqual(['default', 'minimal', 'low', 'medium', 'high']);
  });

  it('crops provider options to catalog-supported reasoning efforts', () => {
    const profile = resolveReasoningProfile(
      'openai',
      model('gpt-5.1', {
        reasoning_options: ['default', 'none', 'medium', 'high'],
        reasoning_default: 'medium',
      }),
    );

    expect(profile.options.map((option) => option.key)).toEqual([
      'default',
      'none',
      'medium',
      'high',
    ]);
    expect(profile.defaultOptionKey).toBe('medium');
  });

  it('uses dedicated OpenAI-compatible provider profiles', () => {
    expect(optionKeys('deepseek', 'deepseek-v4-flash')).toEqual(['default', 'none', 'high', 'max']);
    expect(optionKeys('xai', 'grok-4.3')).toEqual(['default', 'none', 'low', 'medium', 'high']);
    expect(optionKeys('xai', 'grok-3-mini')).toEqual(['default']);
    expect(optionKeys('glm', 'glm-4.6')).toEqual(['default', 'none', 'high']);
    expect(optionKeys('siliconflow', 'Qwen/Qwen3-235B-A22B')).toEqual(['default', 'none', 'low', 'medium', 'high']);

    const deepSeekProfile = resolveReasoningProfile('deepseek', model('deepseek-v4-flash'));
    expect(deepSeekProfile.options.map((option) => option.key)).not.toContain('low');
    expect(deepSeekProfile.options.map((option) => option.key)).not.toContain('medium');
    expect(deepSeekProfile.options.map((option) => option.key)).not.toContain('xhigh');
    expect(resolveReasoningRequest(deepSeekProfile, 'max')).toMatchObject({
      level: 'max',
      apiStyle: 'openai_reasoning_effort',
      reasoningEffort: 'max',
      suppressSamplingParams: true,
    });

    const glmProfile = resolveReasoningProfile('glm', model('glm-4.6'));
    expect(resolveReasoningRequest(glmProfile, 'high')).toEqual({
      level: 'high',
      apiStyle: 'glm_thinking',
      suppressSamplingParams: true,
    });

    const siliconFlowProfile = resolveReasoningProfile('siliconflow', model('Qwen/Qwen3-235B-A22B'));
    expect(resolveReasoningRequest(siliconFlowProfile, 'medium')).toMatchObject({
      level: 'medium',
      apiStyle: 'siliconflow_enable_thinking',
      enableThinking: true,
      budgetTokens: 4096,
      suppressSamplingParams: true,
    });
  });
});
