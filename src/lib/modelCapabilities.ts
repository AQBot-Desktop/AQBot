import type { Model, ModelCapability, ModelType, ProviderConfig } from '@/types';

const CHAT_MODEL_CAPABILITIES: ModelCapability[] = [
  'Vision',
  'FunctionCalling',
  'Reasoning',
];

export function getEditableCapabilities(modelType: ModelType | null | undefined): ModelCapability[] {
  return modelType === 'Chat' || !modelType ? CHAT_MODEL_CAPABILITIES : [];
}

export function sanitizeModelCapabilities(
  modelType: ModelType | null | undefined,
  capabilities: ModelCapability[],
): ModelCapability[] {
  const allowed = new Set(getEditableCapabilities(modelType));
  return capabilities.filter((capability) => allowed.has(capability));
}

export function getVisibleModelCapabilities(
  model: Pick<Model, 'model_type' | 'capabilities'>,
): ModelCapability[] {
  return sanitizeModelCapabilities(model.model_type, model.capabilities);
}

export function modelHasCapability(
  model: Pick<Model, 'capabilities'> | null | undefined,
  capability: ModelCapability,
): boolean {
  return model?.capabilities.includes(capability) ?? false;
}

export function supportsReasoning(model: Pick<Model, 'capabilities'> | null | undefined): boolean {
  return modelHasCapability(model, 'Reasoning');
}

export function findModelByIds(
  providers: ProviderConfig[],
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): Model | null {
  if (!providerId || !modelId) return null;
  const provider = providers.find((item) => item.id === providerId);
  return provider?.models.find((item) => item.model_id === modelId) ?? null;
}
