import { describe, expect, it } from 'vitest';
import type { Model, MultiModelTarget } from '@/types';
import {
  FOLLOW_UNIFIED_THINKING_KEY,
  mergeMultiModelTargetSelection,
  resolveTargetReasoning,
  withTargetThinkingOverride,
} from '../resolveTargetReasoning';

function model(modelId: string, capabilities: Model['capabilities'] = ['Reasoning']): Model {
  return {
    provider_id: 'provider-1',
    model_id: modelId,
    name: modelId,
    model_type: 'Chat',
    capabilities,
    context_window: 128000,
    enabled: true,
    param_overrides: null,
    metadata_state: null,
  };
}

describe('resolveTargetReasoning', () => {
  it('follows the unified thinking level when no override is set', () => {
    expect(resolveTargetReasoning({
      unifiedLevel: 'high',
      unifiedBudget: 4096,
      override: undefined,
      providerType: 'openai',
      model: model('gpt-5.1'),
    })).toEqual({ thinkingLevel: 'high' });
  });

  it('uses the unified legacy budget when following and no unified level is set', () => {
    expect(resolveTargetReasoning({
      unifiedLevel: null,
      unifiedBudget: 4096,
      override: undefined,
      providerType: 'openai',
      model: model('gpt-5.1'),
    })).toEqual({ thinkingBudget: 4096 });
  });

  it('ignores unified settings when the override is model default', () => {
    expect(resolveTargetReasoning({
      unifiedLevel: 'high',
      unifiedBudget: 4096,
      override: null,
      providerType: 'openai',
      model: model('gpt-5.1'),
    })).toEqual({});
  });

  it('uses a specified override instead of the unified level', () => {
    expect(resolveTargetReasoning({
      unifiedLevel: 'high',
      unifiedBudget: null,
      override: 'low',
      providerType: 'openai',
      model: model('gpt-5.1'),
    })).toEqual({ thinkingLevel: 'low' });
  });

  it('coerces an unsupported unified level to the target model default', () => {
    expect(resolveTargetReasoning({
      unifiedLevel: 'xhigh',
      unifiedBudget: null,
      override: undefined,
      providerType: 'gemini',
      model: model('gemini-3.1-flash'),
    })).toEqual({});
  });

  it('does not send thinking params for models without reasoning', () => {
    expect(resolveTargetReasoning({
      unifiedLevel: 'high',
      unifiedBudget: 4096,
      override: 'low',
      providerType: 'openai',
      model: model('gpt-4o', []),
    })).toEqual({});
  });
});

describe('withTargetThinkingOverride', () => {
  it('omits thinkingLevel when following the unified setting', () => {
    expect(withTargetThinkingOverride(
      { providerId: 'p', modelId: 'm', thinkingLevel: 'high' },
      undefined,
    )).toEqual({ providerId: 'p', modelId: 'm' });
  });

  it('stores null for an explicit model default override', () => {
    expect(withTargetThinkingOverride(
      { providerId: 'p', modelId: 'm' },
      null,
    )).toEqual({ providerId: 'p', modelId: 'm', thinkingLevel: null });
  });

  it('maps the follow menu key to an omitted override', () => {
    expect(withTargetThinkingOverride(
      { providerId: 'p', modelId: 'm', thinkingLevel: 'low' },
      FOLLOW_UNIFIED_THINKING_KEY,
    )).toEqual({ providerId: 'p', modelId: 'm' });
  });
});

describe('mergeMultiModelTargetSelection', () => {
  it('keeps existing thinking overrides when the same models are reselected', () => {
    const previous: MultiModelTarget[] = [
      { providerId: 'p1', modelId: 'm1', thinkingLevel: 'low' },
      { providerId: 'p2', modelId: 'm2', thinkingLevel: null },
    ];

    expect(mergeMultiModelTargetSelection(previous, [
      { providerId: 'p2', modelId: 'm2' },
      { providerId: 'p1', modelId: 'm1' },
      { providerId: 'p3', modelId: 'm3' },
    ])).toEqual([
      { providerId: 'p2', modelId: 'm2', thinkingLevel: null },
      { providerId: 'p1', modelId: 'm1', thinkingLevel: 'low' },
      { providerId: 'p3', modelId: 'm3' },
    ]);
  });
});
