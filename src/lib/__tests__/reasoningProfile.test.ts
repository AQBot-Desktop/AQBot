import { describe, expect, it } from 'vitest';
import { resolveReasoningProfile, resolveReasoningRequest } from '../reasoningProfile';
import type { Model, ProviderType } from '@/types';

function model(modelId: string, overrides: Model['param_overrides'] = null): Model {
  return {
    provider_id: 'provider-1',
    model_id: modelId,
    name: modelId,
    model_type: 'Chat',
    capabilities: ['Reasoning'],
    max_tokens: 128000,
    enabled: true,
    param_overrides: overrides,
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

  it('uses dedicated OpenAI-compatible provider profiles', () => {
    expect(optionKeys('deepseek', 'deepseek-v4-flash')).toEqual(['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(optionKeys('xai', 'grok-3-mini')).toEqual(['default']);
    expect(optionKeys('glm', 'glm-4.6')).toEqual(['default', 'none', 'high']);
    expect(optionKeys('siliconflow', 'Qwen/Qwen3-235B-A22B')).toEqual(['default', 'none', 'low', 'medium', 'high']);

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
