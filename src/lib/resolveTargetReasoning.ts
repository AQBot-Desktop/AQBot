import { supportsReasoning } from '@/lib/modelCapabilities';
import { coerceReasoningOptionKey, resolveReasoningProfile } from '@/lib/reasoningProfile';
import { getModelVersionGroupKey } from '@/lib/chatMultiModel';
import type { Model, MultiModelTarget, ProviderType } from '@/types';

export const FOLLOW_UNIFIED_THINKING_KEY = 'follow';

export type ThinkingOverride = string | null | undefined;

export interface ResolveTargetReasoningInput {
  unifiedLevel: string | null;
  unifiedBudget: number | null;
  override?: ThinkingOverride;
  providerType?: ProviderType;
  model: Model | null | undefined;
}

export interface ResolvedTargetReasoning {
  thinkingLevel?: string;
  thinkingBudget?: number;
}

function normalizedOverride(override: ThinkingOverride): ThinkingOverride {
  if (override === FOLLOW_UNIFIED_THINKING_KEY || override === 'default') {
    return override === FOLLOW_UNIFIED_THINKING_KEY ? undefined : null;
  }
  return override;
}

export function resolveTargetReasoning(
  input: ResolveTargetReasoningInput,
): ResolvedTargetReasoning {
  if (!supportsReasoning(input.model)) return {};

  const override = normalizedOverride(input.override);
  if (override !== undefined) {
    if (override === null) return {};
    const profile = resolveReasoningProfile(input.providerType, input.model);
    const optionKey = coerceReasoningOptionKey(profile, override);
    return optionKey === 'default' ? {} : { thinkingLevel: optionKey };
  }

  if (input.unifiedLevel !== null) {
    const profile = resolveReasoningProfile(input.providerType, input.model);
    const optionKey = coerceReasoningOptionKey(profile, input.unifiedLevel);
    return optionKey === 'default' ? {} : { thinkingLevel: optionKey };
  }

  if (input.unifiedBudget === null) return {};
  return { thinkingBudget: input.unifiedBudget };
}

export function withTargetThinkingOverride(
  target: MultiModelTarget,
  override: ThinkingOverride,
): MultiModelTarget {
  const next: MultiModelTarget = {
    providerId: target.providerId,
    modelId: target.modelId,
  };
  const normalized = normalizedOverride(override);
  if (normalized !== undefined) next.thinkingLevel = normalized;
  return next;
}

export function mergeMultiModelTargetSelection(
  previous: ReadonlyArray<MultiModelTarget>,
  selected: ReadonlyArray<Pick<MultiModelTarget, 'providerId' | 'modelId'>>,
): MultiModelTarget[] {
  const previousByKey = new Map(
    previous.map((target) => [
      getModelVersionGroupKey(target.providerId, target.modelId),
      target,
    ]),
  );
  return selected.map((target) => {
    const previousTarget = previousByKey.get(
      getModelVersionGroupKey(target.providerId, target.modelId),
    );
    if (!previousTarget) {
      return { providerId: target.providerId, modelId: target.modelId };
    }
    return withTargetThinkingOverride(previousTarget, previousTarget.thinkingLevel);
  });
}
