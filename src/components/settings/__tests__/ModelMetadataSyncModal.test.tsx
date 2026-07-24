import { describe, expect, it } from 'vitest';
import type { Model, ModelMetadataState } from '@/types';
import { buildMetadataSyncRows } from '../ModelMetadataSyncModal';

function metadataState(): ModelMetadataState {
  return {
    schema_version: 2,
    catalog_key: 'model',
    catalog_mode: 'chat',
    model_type: 'catalog',
    capabilities: 'catalog',
    context_window: 'default',
    max_output_tokens: 'default',
    no_system_role: 'catalog',
    omit_sampling_params: 'default',
    reasoning_options: 'catalog',
  };
}

function model(): Model {
  return {
    provider_id: 'provider',
    model_id: 'model',
    name: 'Model',
    group_name: null,
    model_type: 'Chat',
    capabilities: ['TextChat', 'Reasoning'],
    context_window: 16_000,
    max_output_tokens: null,
    enabled: true,
    param_overrides: {
      no_system_role: true,
      reasoning_options: ['high'],
    },
    metadata_state: metadataState(),
  };
}

describe('buildMetadataSyncRows', () => {
  it('compares array fields as sets and distinguishes unavailable from explicit false', () => {
    const current = model();
    const inferred: Model = {
      ...current,
      capabilities: ['Reasoning', 'TextChat'],
      context_window: null,
      param_overrides: {
        ...current.param_overrides,
        no_system_role: false,
        reasoning_options: [],
      },
      metadata_state: metadataState(),
    };

    const rows = new Map(
      buildMetadataSyncRows(current, inferred).map((row) => [row.field, row]),
    );

    expect(rows.get('capabilities')).toMatchObject({
      available: true,
      changed: false,
    });
    expect(rows.get('context_window')).toMatchObject({
      available: false,
      changed: false,
    });
    expect(rows.get('no_system_role')).toMatchObject({
      available: true,
      changed: true,
      inferred: false,
    });
    expect(rows.get('reasoning_options')).toMatchObject({
      available: true,
      changed: true,
      inferred: [],
    });
  });
});
