import { describe, expect, it } from 'vitest';

import type { Message } from '@/types';
import {
  getMessageVersionGroupKey,
  getModelVersionGroupKey,
  getLatestVersionsByModel,
  hasMultipleModelVersions,
  applyMultiModelStreamError,
  insertModelVersionPlaceholder,
  mergeAssistantVersionGroup,
  mergeAssistantVersionsAfterSwitch,
  resolvePendingDisplayVersionSelection,
  selectDisplayVersionsByModel,
  selectRenderableVersionSet,
  selectNextAssistantVersion,
  shouldRenderStandaloneAssistantError,
} from '../chatMultiModel';

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'assistant',
    content: '',
    provider_id: 'provider-1',
    model_id: 'model-1',
    token_count: null,
    attachments: [],
    thinking: null,
    tool_calls_json: null,
    tool_call_id: null,
    created_at: 1,
    parent_message_id: 'user-1',
    version_index: 0,
    is_active: true,
    status: 'complete',
    ...overrides,
  };
}

describe('chatMultiModel helpers', () => {
  it('does not downgrade non-tabs multi-model errors into standalone alerts', () => {
    expect(shouldRenderStandaloneAssistantError('error', true)).toBe(false);
    expect(shouldRenderStandaloneAssistantError('error', false)).toBe(true);
  });

  it('keeps distinct error versions even when model metadata is missing', () => {
    const latest = getLatestVersionsByModel([
      makeMessage({ id: 'error-1', model_id: null, provider_id: null, status: 'error', created_at: 1 }),
      makeMessage({ id: 'error-2', model_id: null, provider_id: null, status: 'error', created_at: 2 }),
      makeMessage({ id: 'model-2', model_id: 'model-2', created_at: 3 }),
    ]);

    expect(latest.map((message) => message.id)).toEqual(['error-1', 'error-2', 'model-2']);
  });

  it('groups identical model ids separately for different providers', () => {
    const providerA = makeMessage({ id: 'provider-a', provider_id: 'provider-a', model_id: 'shared-model' });
    const providerB = makeMessage({ id: 'provider-b', provider_id: 'provider-b', model_id: 'shared-model' });

    expect(getModelVersionGroupKey('provider-a', 'shared-model')).toBe('provider-a:shared-model');
    expect(getMessageVersionGroupKey(providerA)).not.toBe(getMessageVersionGroupKey(providerB));
    expect(getLatestVersionsByModel([providerA, providerB])).toEqual([providerA, providerB]);
    expect(hasMultipleModelVersions([providerA, providerB])).toBe(true);
  });

  it('keeps the current active answer visible while adding a new model response', () => {
    const current = makeMessage({ id: 'active', model_id: 'model-a', is_active: true, content: 'ready' });
    const placeholder = makeMessage({
      id: 'temp-assistant-2',
      model_id: 'model-b',
      provider_id: 'provider-2',
      is_active: false,
      status: 'partial',
    });

    const next = insertModelVersionPlaceholder([current], current.parent_message_id!, placeholder);

    expect(next).toHaveLength(2);
    expect(next.find((message) => message.id === 'active')?.is_active).toBe(true);
    expect(next.find((message) => message.id === 'temp-assistant-2')?.is_active).toBe(false);
  });

  it('removes deleted local versions when backend returns the remaining version set', () => {
    const deleted = makeMessage({ id: 'error-version', model_id: null, provider_id: null, status: 'error', is_active: false });
    const remaining = makeMessage({ id: 'good-version', model_id: 'model-b', is_active: true, content: 'ok' });
    const unrelated = makeMessage({ id: 'other-parent', parent_message_id: 'user-2', content: 'keep me' });

    const next = mergeAssistantVersionsAfterSwitch(
      [deleted, remaining, unrelated],
      deleted.parent_message_id!,
      [remaining],
      remaining.id,
    );

    expect(next.map((message) => message.id)).toEqual(['good-version', 'other-parent']);
    expect(next.find((message) => message.id === 'good-version')?.is_active).toBe(true);
  });

  it('detects when cached versions are no longer multi-model', () => {
    expect(hasMultipleModelVersions([
      makeMessage({ id: 'model-a', model_id: 'model-a' }),
      makeMessage({ id: 'model-b', model_id: 'model-b' }),
    ])).toBe(true);

    expect(hasMultipleModelVersions([
      makeMessage({ id: 'single', model_id: 'model-a' }),
    ])).toBe(false);
  });

  it('uses the active same-model version instead of the latest version for display', () => {
    const oldVersion = makeMessage({
      id: 'model-a-old',
      model_id: 'model-a',
      content: 'old answer',
      is_active: true,
      version_index: 0,
      created_at: 1,
    });
    const latestVersion = makeMessage({
      id: 'model-a-latest',
      model_id: 'model-a',
      content: 'latest answer',
      is_active: false,
      version_index: 1,
      created_at: 2,
    });
    const otherModel = makeMessage({
      id: 'model-b',
      model_id: 'model-b',
      content: 'other answer',
      is_active: false,
      version_index: 0,
      created_at: 3,
    });

    const displayVersions = selectDisplayVersionsByModel(
      [oldVersion, latestVersion, otherModel],
      oldVersion.id,
    );

    expect(displayVersions.map((message) => message.id)).toEqual(['model-a-old', 'model-b']);
  });

  it('keeps latest versions for models that are not currently active', () => {
    const oldVersion = makeMessage({
      id: 'model-a-old',
      model_id: 'model-a',
      content: 'old answer',
      is_active: false,
      version_index: 0,
      created_at: 1,
    });
    const latestVersion = makeMessage({
      id: 'model-a-latest',
      model_id: 'model-a',
      content: 'latest answer',
      is_active: false,
      version_index: 1,
      created_at: 2,
    });
    const activeOtherModel = makeMessage({
      id: 'model-b',
      model_id: 'model-b',
      content: 'other answer',
      is_active: true,
      version_index: 0,
      created_at: 3,
    });

    const displayVersions = selectDisplayVersionsByModel(
      [oldVersion, latestVersion, activeOtherModel],
      activeOtherModel.id,
    );

    expect(displayVersions.map((message) => message.id)).toEqual(['model-a-latest', 'model-b']);
  });

  it('uses a per-model display override without changing the active context version', () => {
    const activeOldVersion = makeMessage({
      id: 'model-a-old',
      model_id: 'model-a',
      provider_id: 'provider-a',
      content: 'old answer',
      is_active: true,
      version_index: 0,
      created_at: 1,
    });
    const displayOverrideVersion = makeMessage({
      id: 'model-a-new',
      model_id: 'model-a',
      provider_id: 'provider-a',
      content: 'new answer',
      is_active: false,
      version_index: 1,
      created_at: 2,
    });
    const otherModel = makeMessage({
      id: 'model-b',
      model_id: 'model-b',
      provider_id: 'provider-b',
      content: 'other answer',
      is_active: false,
      version_index: 0,
      created_at: 3,
    });

    const displayVersions = selectDisplayVersionsByModel(
      [activeOldVersion, displayOverrideVersion, otherModel],
      activeOldVersion.id,
      new Map([[getMessageVersionGroupKey(displayOverrideVersion), displayOverrideVersion.id]]),
    );

    expect(displayVersions.map((message) => message.id)).toEqual(['model-a-new', 'model-b']);
    expect(activeOldVersion.is_active).toBe(true);
  });

  it('falls back to the active or latest model version when a display override is stale', () => {
    const activeOldVersion = makeMessage({
      id: 'model-a-old',
      model_id: 'model-a',
      provider_id: 'provider-a',
      is_active: true,
      version_index: 0,
      created_at: 1,
    });
    const latestVersion = makeMessage({
      id: 'model-a-new',
      model_id: 'model-a',
      provider_id: 'provider-a',
      is_active: false,
      version_index: 1,
      created_at: 2,
    });

    const displayVersions = selectDisplayVersionsByModel(
      [activeOldVersion, latestVersion],
      activeOldVersion.id,
      new Map([[getMessageVersionGroupKey(activeOldVersion), 'deleted-version']]),
    );

    expect(displayVersions.map((message) => message.id)).toEqual(['model-a-old']);
  });

  it('keeps a pending regenerated page selected until the real streaming version appears', () => {
    const previousVersion = makeMessage({
      id: 'model-a-v4',
      model_id: 'model-a',
      provider_id: 'provider-a',
      is_active: false,
      version_index: 3,
      created_at: 4,
    });
    const modelKey = getMessageVersionGroupKey(previousVersion);

    const unresolved = resolvePendingDisplayVersionSelection(
      [previousVersion],
      modelKey,
      'temp-assistant-v5',
      { messageId: 'temp-assistant-v5', versionIndex: 4, createdAt: 5 },
    );

    expect(unresolved).toBe('temp-assistant-v5');
  });

  it('resolves a pending regenerated page from temp id to the real streaming id', () => {
    const previousVersion = makeMessage({
      id: 'model-a-v4',
      model_id: 'model-a',
      provider_id: 'provider-a',
      is_active: false,
      version_index: 3,
      created_at: 4,
    });
    const streamingVersion = makeMessage({
      id: 'model-a-v5',
      model_id: 'model-a',
      provider_id: 'provider-a',
      is_active: false,
      status: 'partial',
      version_index: 4,
      created_at: 5,
    });
    const modelKey = getMessageVersionGroupKey(streamingVersion);

    const resolved = resolvePendingDisplayVersionSelection(
      [previousVersion, streamingVersion],
      modelKey,
      'temp-assistant-v5',
      { messageId: 'temp-assistant-v5', versionIndex: 4, createdAt: 5 },
    );

    expect(resolved).toBe('model-a-v5');
  });

  it('picks a remaining fallback version after deleting the active one', () => {
    const fallback = makeMessage({ id: 'fallback', model_id: 'model-b', version_index: 0, created_at: 1 });
    const deleted = makeMessage({ id: 'deleted', model_id: 'model-a', version_index: 1, created_at: 2, status: 'error' });

    expect(selectNextAssistantVersion([fallback, deleted], deleted.id)?.id).toBe('fallback');
  });

  it('prefers another version from the same provider and model after deletion', () => {
    const sameTarget = makeMessage({
      id: 'same-target',
      provider_id: 'provider-a',
      model_id: 'shared-model',
      version_index: 0,
    });
    const providerCollision = makeMessage({
      id: 'provider-collision',
      provider_id: 'provider-b',
      model_id: 'shared-model',
      version_index: 9,
    });
    const deleted = makeMessage({
      id: 'deleted',
      provider_id: 'provider-a',
      model_id: 'shared-model',
      version_index: 1,
    });

    expect(selectNextAssistantVersion([sameTarget, providerCollision, deleted], deleted.id)?.id)
      .toBe('same-target');
  });

  it('merges a complete version group back after an active-only message refresh', () => {
    const user = makeMessage({
      id: 'user-1',
      role: 'user',
      content: 'question',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    });
    const activeError = makeMessage({
      id: 'active-error',
      model_id: 'model-a',
      provider_id: 'provider-a',
      status: 'error',
      content: 'boom',
      is_active: true,
      version_index: 0,
    });
    const inactiveSuccess = makeMessage({
      id: 'inactive-success',
      model_id: 'model-b',
      provider_id: 'provider-b',
      content: 'ok',
      is_active: false,
      version_index: 1,
    });

    const merged = mergeAssistantVersionGroup(
      [user, activeError],
      user.id,
      [activeError, inactiveSuccess],
      activeError.id,
    );

    expect(merged.map((message) => message.id)).toEqual(['user-1', 'active-error', 'inactive-success']);
    expect(merged.find((message) => message.id === 'active-error')?.is_active).toBe(true);
    expect(merged.find((message) => message.id === 'inactive-success')?.is_active).toBe(false);
  });

  it('resolves a temp first-model placeholder when the stream errors before any chunk arrives', () => {
    const user = makeMessage({
      id: 'user-1',
      role: 'user',
      content: 'question',
      provider_id: null,
      model_id: null,
      parent_message_id: null,
    });
    const placeholder = makeMessage({
      id: 'temp-assistant-1',
      model_id: 'model-a',
      provider_id: 'provider-a',
      content: '',
      parent_message_id: user.id,
      is_active: true,
      status: 'partial',
    });

    const result = applyMultiModelStreamError([user, placeholder], {
      conversationId: 'conv-1',
      parentMessageId: user.id,
      streamingMessageId: placeholder.id,
      messageId: 'db-assistant-1',
      error: 'provider failed',
      modelId: 'model-a',
      providerId: 'provider-a',
    });

    expect(result.streamingMessageId).toBe('db-assistant-1');
    expect(result.messages.map((message) => message.id)).toEqual(['user-1', 'db-assistant-1']);
    expect(result.messages[1]).toMatchObject({
      content: 'provider failed',
      status: 'error',
      model_id: 'model-a',
      provider_id: 'provider-a',
      parent_message_id: 'user-1',
      is_active: true,
    });
  });

  it('prefers hydrated store versions over a larger stale cached version list', () => {
    const active = makeMessage({
      id: 'active',
      model_id: 'model-a',
      is_active: true,
      version_index: 0,
    });
    const remaining = makeMessage({
      id: 'remaining',
      model_id: 'model-b',
      is_active: false,
      version_index: 1,
    });
    const deleted = makeMessage({
      id: 'deleted',
      model_id: 'model-c',
      is_active: false,
      version_index: 2,
    });

    expect(selectRenderableVersionSet([active, remaining], [active, remaining, deleted]).map((message) => message.id))
      .toEqual(['active', 'remaining']);
  });
});
