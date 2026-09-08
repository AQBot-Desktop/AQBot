import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model, ModelTestConfig, ModelTestResult, ProviderConfig } from '@/types';
import { useProviderStore, useSettingsStore } from '@/stores';
import { useModelTestQueue } from '../useModelTestQueue';

const mocks = vi.hoisted(() => ({
  config: vi.fn(), run: vi.fn(), cancel: vi.fn(), error: vi.fn(), flush: vi.fn(),
  load: vi.fn(), save: vi.fn(), desktop: true, t: (key: string) => key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('antd', () => ({ App: { useApp: () => ({ message: { error: mocks.error } }) } }));
vi.mock('@/lib/invoke', () => ({ isTauri: () => mocks.desktop, invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@/stores', async () => ({
  useProviderStore: (await import('@/stores/providerStore')).useProviderStore,
  useSettingsStore: (await import('@/stores/settingsStore')).useSettingsStore,
}));
vi.mock('@/lib/modelTest', async (load) => ({
  ...await load<typeof import('@/lib/modelTest')>(),
  getModelTestConfig: mocks.config, runModelTest: mocks.run, cancelModelTest: mocks.cancel,
}));

const config: ModelTestConfig = {
  default_prompt: 'Say 1', max_prompt_chars: 2000, timeout_secs: 120,
  adapter_kinds: [{ provider_type: 'openai', kinds: ['chat', 'embedding'] }],
};
function model(id: string, enabled = true): Model {
  return { model_id: id, provider_id: 'p1', name: id, group_name: 'group', model_type: 'Chat',
    enabled, capabilities: ['TextChat'], param_overrides: null, context_window: null };
}
function provider(): ProviderConfig {
  return { id: 'p1', name: 'Provider', provider_type: 'openai', api_host: 'https://example.test',
    api_path: null, aws_region: null, enabled: true, custom_headers: null, icon: null, builtin_id: null,
    models: [model('a'), model('b', false)], keys: [], proxy_config: null, sort_order: 0,
    created_at: 0, updated_at: 0 };
}
function result(modelId: string, status: ModelTestResult['status'] = 'passed'): ModelTestResult {
  return { test_id: 'test', provider_id: 'p1', model_id: modelId, status, first_text_ms: 50,
    total_ms: 100, checked_at: 0, response_preview: 'OK', error_code: null, error_detail: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function setup() {
  const hook = renderHook(({ providerId }) => {
    const selected = useProviderStore((state) => state.providers.find((item) => item.id === providerId));
    return useModelTestQueue({ providerId, provider: selected, flushPendingEdits: mocks.flush });
  }, { initialProps: { providerId: 'p1' } });
  await waitFor(() => expect(hook.result.current.config).toEqual(config));
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = true;
  mocks.config.mockResolvedValue(config);
  mocks.flush.mockResolvedValue(undefined);
  mocks.load.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.run.mockImplementation(async (input) => result(input.modelId));
  mocks.save.mockImplementation(async (partial) => {
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, ...partial } }));
    return [];
  });
  useProviderStore.setState({ providers: [provider()] });
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, model_test_prompt: null, proxy_address: null },
    settingsMeta: { ...state.settingsMeta, status: 'ready' },
    ensureSettingsLoaded: mocks.load, saveSettings: mocks.save, _loaded: true,
  }));
});

describe('model test queue', () => {
  it('loads the official default without making the form dirty and persists reset as null', async () => {
    const { result: hook } = await setup();
    expect(hook.current.promptDraft).toBe('');
    expect(hook.current.promptDirty).toBe(false);
    act(() => { useSettingsStore.setState((state) => ({ settings: { ...state.settings, model_test_prompt: 'custom' } })); });
    act(() => { hook.current.restoreDefault(); });
    await act(async () => { await hook.current.savePrompt(); });
    expect(mocks.save).toHaveBeenCalledWith({ model_test_prompt: null }, { throwOnError: true });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('reports config failures instead of synthesizing unsupported results', async () => {
    mocks.config.mockRejectedValue(new Error('offline'));
    const { result: hook } = renderHook(() => useModelTestQueue({ providerId: 'p1', provider: provider(), flushPendingEdits: mocks.flush }));
    await waitFor(() => expect(hook.current.configError).toContain('offline'));
    await act(async () => { await hook.current.start(); });
    expect(hook.current.config).toBeNull();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(hook.current.results.size).toBe(0);
  });

  it('serializes all models, displays first text immediately and freezes the prompt', async () => {
    const first = deferred<ModelTestResult>();
    mocks.run.mockImplementationOnce(() => first.promise);
    const { result: hook } = await setup();
    let execution!: Promise<void>;
    act(() => { execution = hook.current.start(); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    const input = mocks.run.mock.calls[0][0];
    act(() => { input.onEvent({ type: 'first_text', test_id: input.testId, first_text_ms: 23 }); });
    expect(hook.current.firstTextTimes.get('a')).toBe(23);
    expect(hook.current.results.has('a')).toBe(false);
    await act(async () => { first.resolve(result('a')); await execution; });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run.mock.calls.map(([call]) => call.prompt)).toEqual([config.default_prompt, config.default_prompt]);
    expect(mocks.run.mock.calls.map(([call]) => call.thinkingLevel)).toEqual([null, null]);
    expect(hook.current.results.get('b')?.status).toBe('passed');
    act(() => { input.onEvent({ type: 'first_text', test_id: input.testId, first_text_ms: 999 }); });
    expect(hook.current.firstTextTimes.get('a')).toBe(23);
  });

  it('tests only enabled models and resolves the complete group independently of visible rows', async () => {
    const { result: hook } = await setup();
    act(() => { hook.current.openPanel('group', [model('a')]); });
    expect(hook.current.targetModels.map((item) => item.model_id)).toEqual(['a', 'b']);
    act(() => { hook.current.setScope('enabled'); });
    await act(async () => { await hook.current.start(); });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][0].modelId).toBe('a');
  });

  it('does not send a request after saving the prompt fails', async () => {
    mocks.save.mockRejectedValue(new Error('disk full'));
    const { result: hook } = await setup();
    act(() => { hook.current.setPromptDraft('new'); });
    await act(async () => { await hook.current.start(); });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(hook.current.promptDraft).toBe('new');
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('does not cancel its own save-and-test operation or use a stale endpoint snapshot', async () => {
    const pending = deferred<ModelTestResult>();
    mocks.run.mockImplementationOnce(() => pending.promise);
    mocks.flush.mockImplementation(async () => {
      useProviderStore.setState((state) => ({ providers: state.providers.map((item) => ({ ...item, api_host: 'https://new.test' })) }));
    });
    const { result: hook } = await setup();
    act(() => { hook.current.setPromptDraft('changed'); });
    let execution!: Promise<void>;
    act(() => { execution = hook.current.start(); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(hook.current.running).toBe(true);
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(result('a')); await execution; });
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(hook.current.results.get('a')?.status).toBe('passed');
  });

  it('remembers cancellation before registration and retains returned cancellation timing', async () => {
    const pending = deferred<ModelTestResult>();
    mocks.run.mockImplementationOnce(() => pending.promise);
    const { result: hook } = await setup();
    let execution!: Promise<void>;
    act(() => { execution = hook.current.start(); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    await act(async () => { await hook.current.stop(); await hook.current.start(); });
    expect(hook.current.running).toBe(true);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    const input = mocks.run.mock.calls[0][0];
    await act(async () => { input.onEvent({ type: 'registered', test_id: input.testId }); });
    expect(mocks.cancel).toHaveBeenCalledWith(input.testId);
    await act(async () => { pending.resolve(result('a', 'cancelled')); await execution; });
    expect(hook.current.results.get('a')?.total_ms).toBe(100);
    expect(hook.current.results.get('b')?.status).toBe('cancelled');
    expect(hook.current.running).toBe(false);
  });

  it('reports a cancellation transport failure and allows an explicit retry', async () => {
    const pending = deferred<ModelTestResult>();
    mocks.run.mockImplementationOnce(() => pending.promise);
    mocks.cancel.mockRejectedValueOnce(new Error('IPC failed'));
    const { result: hook } = await setup();
    let execution!: Promise<void>;
    act(() => { execution = hook.current.start(); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    const input = mocks.run.mock.calls[0][0];
    act(() => { input.onEvent({ type: 'registered', test_id: input.testId }); });
    await act(async () => { await hook.current.stop(); });
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('cancelError'));
    expect(hook.current.running).toBe(true);
    await act(async () => { await hook.current.stop(); });
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve(result('a', 'cancelled')); await execution; });
  });

  it('invalidates results and cancels when the global proxy changes', async () => {
    const pending = deferred<ModelTestResult>();
    mocks.run.mockImplementationOnce(() => pending.promise);
    const { result: hook } = await setup();
    let execution!: Promise<void>;
    act(() => { execution = hook.current.start(); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    const input = mocks.run.mock.calls[0][0];
    act(() => { input.onEvent({ type: 'registered', test_id: input.testId }); });
    act(() => { useSettingsStore.setState((state) => ({ settings: { ...state.settings, proxy_address: 'new-proxy' } })); });
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(input.testId));
    await act(async () => { pending.resolve(result('a')); await execution; });
    expect(hook.current.results.size).toBe(0);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('cancels after leaving the page even when registration arrives after unmount', async () => {
    const pending = deferred<ModelTestResult>();
    mocks.run.mockImplementationOnce(() => pending.promise);
    const { result: hook, unmount } = await setup();
    let execution!: Promise<void>;
    act(() => { execution = hook.current.start(); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    unmount();
    const input = mocks.run.mock.calls[0][0];
    input.onEvent({ type: 'registered', test_id: input.testId });
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(input.testId));
    pending.resolve(result('a', 'cancelled'));
    await execution;
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a prepared batch after switching providers', async () => {
    const pendingSave = deferred<void>();
    mocks.flush.mockImplementationOnce(() => pendingSave.promise);
    useProviderStore.setState((state) => ({ providers: [...state.providers, { ...provider(), id: 'p2', models: [] }] }));
    const { result: hook, rerender } = await setup();
    act(() => { hook.current.openPanel('all'); });
    let execution!: Promise<void>;
    act(() => { execution = hook.current.start(); });
    expect(hook.current.preparing).toBe(true);
    rerender({ providerId: 'p2' });
    await act(async () => { pendingSave.resolve(); await execution; });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(hook.current.panelOpen).toBe(false);
    expect(hook.current.results.size).toBe(0);
    expect(hook.current.running).toBe(false);
  });

  it('runs at most three models in parallel and refills a slot after completion', async () => {
    const pending = Array.from({ length: 5 }, () => deferred<ModelTestResult>());
    useProviderStore.setState({ providers: [{ ...provider(), models: ['a', 'b', 'c', 'd', 'e'].map((id) => model(id)) }] });
    mocks.run.mockImplementation((input) => pending['abcde'.indexOf(input.modelId)].promise);
    const { result: hook } = await setup();
    act(() => { hook.current.setExecution('parallel'); });
    let execution!: Promise<void>;
    act(() => { execution = hook.current.start(); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(3));
    expect(hook.current.runningModelIds).toEqual(new Set(['a', 'b', 'c']));
    const firstInputs = mocks.run.mock.calls.map(([input]) => input);
    act(() => firstInputs.forEach((input, index) => input.onEvent({ type: 'first_text', test_id: input.testId, first_text_ms: index + 10 })));
    expect([...hook.current.firstTextTimes.values()]).toEqual([10, 11, 12]);
    await act(async () => { pending[1].resolve(result('b')); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(4));
    expect(hook.current.runningModelIds).toEqual(new Set(['a', 'c', 'd']));
    await act(async () => { pending[0].reject(new Error('upstream failed')); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(5));
    await act(async () => {
      pending[2].resolve(result('c')); pending[3].resolve(result('d')); pending[4].resolve(result('e'));
      await execution;
    });
    expect(hook.current.results.get('a')?.status).toBe('failed');
    expect(hook.current.results.get('e')?.status).toBe('passed');
    expect(hook.current.results.size).toBe(5);
    expect(hook.current.runningModelIds.size).toBe(0);
  });

  it('cancels every parallel request including late registrations without dispatching queued models', async () => {
    const pending = Array.from({ length: 3 }, () => deferred<ModelTestResult>());
    useProviderStore.setState({ providers: [{ ...provider(), models: ['a', 'b', 'c', 'd'].map((id) => model(id)) }] });
    mocks.run.mockImplementation((input) => pending['abc'.indexOf(input.modelId)].promise);
    const { result: hook } = await setup();
    act(() => { hook.current.setExecution('parallel'); });
    let execution!: Promise<void>;
    act(() => { execution = hook.current.start(); });
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(3));
    const inputs = mocks.run.mock.calls.map(([input]) => input);
    act(() => { inputs[0].onEvent({ type: 'registered', test_id: inputs[0].testId }); });
    await act(async () => { await hook.current.stop(); });
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    await act(async () => { inputs.slice(1).forEach((input) => input.onEvent({ type: 'registered', test_id: input.testId })); });
    expect(mocks.cancel.mock.calls.map(([id]) => id)).toEqual(inputs.map((input) => input.testId));
    await act(async () => { pending[0].resolve(result('a', 'cancelled')); });
    expect(hook.current.running).toBe(true);
    await act(async () => {
      pending[1].resolve(result('b', 'cancelled')); pending[2].resolve(result('c', 'cancelled'));
      await execution;
    });
    expect(mocks.run).toHaveBeenCalledTimes(3);
    expect([...hook.current.results.values()].map((item) => item.status)).toEqual(Array(4).fill('cancelled'));
  });

  it('excludes unsupported model types and adapter capabilities from every test scope', async () => {
    const models = [model('chat'), { ...model('embed'), model_type: 'Embedding' as const },
      { ...model('rerank'), model_type: 'Rerank' as const }, { ...model('image'), model_type: 'Image' as const },
      { ...model('voice'), model_type: 'Voice' as const }];
    useProviderStore.setState({ providers: [{ ...provider(), models }] });
    const { result: hook } = await setup();
    expect(hook.current.supportedModels.map((item) => item.model_id)).toEqual(['chat', 'embed']);
    expect(hook.current.targetModels.map((item) => item.model_id)).toEqual(['chat', 'embed']);
    act(() => { hook.current.openPanel('group', models); });
    expect(hook.current.targetModels.map((item) => item.model_id)).toEqual(['chat', 'embed']);
    act(() => { hook.current.openPanel('single', [models[3]]); });
    expect(hook.current.targetModels).toEqual([]);
    await act(async () => { await hook.current.testInline(models[3]); });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(hook.current.results.size).toBe(0);
  });
});
