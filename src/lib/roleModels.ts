import type { ProviderConfig, Role, RoleModelBinding } from '@/types';

export class RoleModelBindingError extends Error {
  constructor(
    public readonly code: 'ROLE_MODEL_BINDINGS_INVALID' | 'ROLE_MODEL_BINDINGS_UNAVAILABLE',
    public readonly binding?: RoleModelBinding,
  ) {
    super(code);
    this.name = 'RoleModelBindingError';
  }
}

export function resolveRoleModelBinding(binding: RoleModelBinding, providers: ProviderConfig[]) {
  if (!binding.provider_id.trim() || !binding.model_id.trim()) {
    throw new RoleModelBindingError('ROLE_MODEL_BINDINGS_INVALID', binding);
  }
  const provider = providers.find((item) => item.id === binding.provider_id);
  const model = provider?.models.find((item) => item.model_id === binding.model_id);
  if (!provider?.enabled || !model?.enabled || model.model_type !== 'Chat') {
    throw new RoleModelBindingError('ROLE_MODEL_BINDINGS_UNAVAILABLE', binding);
  }
  return { provider, model };
}

export function validateRoleModelBindings(bindings: RoleModelBinding[], providers: ProviderConfig[]) {
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = JSON.stringify([binding.provider_id, binding.model_id]);
    if (seen.has(key)) throw new RoleModelBindingError('ROLE_MODEL_BINDINGS_INVALID', binding);
    seen.add(key);
    resolveRoleModelBinding(binding, providers);
  }
}

export function resolveRoleDefaultModel(role: Pick<Role, 'model_bindings'>, providers: ProviderConfig[]) {
  const binding = role.model_bindings?.[0];
  return binding ? resolveRoleModelBinding(binding, providers) : null;
}
