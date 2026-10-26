import { describe, expect, it } from 'vitest';
import type { ProviderConfig, RoleModelBinding } from '@/types';
import { resolveRoleDefaultModel, validateRoleModelBindings } from '../roleModels';

const binding: RoleModelBinding = { provider_id: 'provider', model_id: 'chat' };
const provider: ProviderConfig = {
  id: 'provider', name: 'Provider', provider_type: 'openai', api_host: '', api_path: null,
  aws_region: null, enabled: true, keys: [], proxy_config: null, custom_headers: null,
  icon: null, builtin_id: null, sort_order: 0, created_at: 0, updated_at: 0,
  models: [{ provider_id: 'provider', model_id: 'chat', name: 'Chat', model_type: 'Chat',
    capabilities: [], context_window: null, enabled: true, param_overrides: null }],
};

describe('role model resolution', () => {
  it('retains legacy model selection only for unbound roles', () => {
    expect(resolveRoleDefaultModel({}, [provider])).toBeNull();
    expect(resolveRoleDefaultModel({ model_bindings: [] }, [provider])).toBeNull();
  });
  it('uses the first binding as default without changing the order', () => {
    const bindings = [binding, { ...binding, model_id: 'unavailable-secondary' }];
    expect(resolveRoleDefaultModel({ model_bindings: bindings }, [provider])).toEqual({ provider, model: provider.models[0] });
    expect(bindings[0]).toBe(binding);
  });
  it('fails explicitly for absent/disabled providers, missing/disabled/non-chat models', () => {
    const role = { model_bindings: [binding] };
    for (const providers of [[], [{ ...provider, enabled: false }], [{ ...provider, models: [] }],
      [{ ...provider, models: [{ ...provider.models[0], enabled: false }] }],
      [{ ...provider, models: [{ ...provider.models[0], model_type: 'Image' as const }] }]]) {
      expect(() => resolveRoleDefaultModel(role, providers)).toThrow('ROLE_MODEL_BINDINGS_UNAVAILABLE');
    }
  });
  it('validates secondary bindings and duplicate identities', () => {
    expect(() => validateRoleModelBindings([binding, binding], [provider])).toThrow('ROLE_MODEL_BINDINGS_INVALID');
    expect(() => validateRoleModelBindings([binding, { ...binding, model_id: 'missing' }], [provider])).toThrow('ROLE_MODEL_BINDINGS_UNAVAILABLE');
  });
});
