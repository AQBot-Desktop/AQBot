import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { App } from 'antd';
import { getModelGroupName } from '@/lib/modelSync';
import { supportsReasoning } from '@/lib/modelCapabilities';
import { coerceReasoningOptionKey, resolveReasoningProfile } from '@/lib/reasoningProfile';
import {
  adapterSupportsKind, cancelModelTest, getModelTestConfig, modelTestFingerprint,
  modelTestKind, normalizeModelTestPrompt, pendingModelTestResult, runModelTest,
} from '@/lib/modelTest';
import { isTauri } from '@/lib/invoke';
import { useProviderStore, useSettingsStore } from '@/stores';
import type { Model, ModelTestConfig, ModelTestResult, ProviderConfig } from '@/types';

export type ModelTestExecution = 'serial' | 'parallel';
export const MODEL_TEST_PARALLEL_LIMIT = 3;

export type ModelTestScope = 'all' | 'enabled';
export type ModelTestPanelMode = 'single' | 'group' | 'all';
export type ModelTestUiStatus = ModelTestResult['status'] | 'idle' | 'queued' | 'running';

interface Batch {
  cancelled: boolean;
  invalidated: boolean;
  phase: 'preparing' | 'running';
  inFlight: Map<string, { id: string; registered: boolean; cancelling: boolean }>;
}

interface Options {
  providerId: string;
  provider: ProviderConfig | undefined;
  flushPendingEdits: () => Promise<void>;
}

export function useModelTestQueue({ providerId, provider, flushPendingEdits }: Options) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const settings = useSettingsStore((state) => state.settings);
  const savedPrompt = settings.model_test_prompt ?? null;
  const saveSettings = useSettingsStore((state) => state.saveSettings);
  const ensureSettingsLoaded = useSettingsStore((state) => state.ensureSettingsLoaded);
  const [config, setConfig] = useState<ModelTestConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<ModelTestPanelMode>('all');
  const [execution, setExecution] = useState<ModelTestExecution>('serial');
  const [scope, setScope] = useState<ModelTestScope>('all');
  const [promptDraft, setPromptDraft] = useState(savedPrompt ?? '');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [groupName, setGroupName] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [results, setResults] = useState<Map<string, ModelTestResult>>(new Map());
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [firstTextTimes, setFirstTextTimes] = useState<Map<string, number>>(new Map());
  const [runningModelIds, setRunningModelIds] = useState<Set<string>>(new Set());
  const [doneCount, setDoneCount] = useState(0);
  const batchRef = useRef<Batch | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const reportCancelError = useRef((error: unknown) => {
    message.error(`${t('settings.modelTest.cancelError')}: ${String(error)}`);
  });
  reportCancelError.current = (error) => { message.error(`${t('settings.modelTest.cancelError')}: ${String(error)}`); };
  const fingerprint = modelTestFingerprint(provider, settings);
  const resultFingerprint = useRef(fingerprint);

  const reloadConfig = useCallback(async () => {
    if (!isTauri()) return;
    setConfigLoading(true);
    setConfigError(null);
    try {
      const [loaded] = await Promise.all([getModelTestConfig(), ensureSettingsLoaded()]);
      if (useSettingsStore.getState().settingsMeta.status !== 'ready') throw new Error('settings unavailable');
      if (mountedRef.current) setConfig(loaded);
    } catch (error) {
      if (mountedRef.current) { setConfig(null); setConfigError(String(error)); }
    } finally {
      if (mountedRef.current) setConfigLoading(false);
    }
  }, [ensureSettingsLoaded]);

  useEffect(() => { void reloadConfig(); }, [reloadConfig]);
  useEffect(() => { setPromptDraft(savedPrompt ?? ''); }, [savedPrompt, providerId]);

  const requestCancel = useCallback(async (batch: Batch) => {
    await Promise.all([...batch.inFlight.values()].map(async (current) => {
      if (!current.registered || current.cancelling) return;
      current.cancelling = true;
      try {
        await cancelModelTest(current.id);
      } catch (error) {
        current.cancelling = false;
        reportCancelError.current(error);
      }
    }));
  }, []);

  const stop = useCallback(async () => {
    const batch = batchRef.current;
    if (!batch) return;
    batch.cancelled = true;
    setStopping(true);
    await requestCancel(batch);
  }, [requestCancel]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const batch = batchRef.current;
      if (batch) { batch.cancelled = true; batch.invalidated = true; void requestCancel(batch); }
    };
  }, [requestCancel]);

  useEffect(() => {
    const batch = batchRef.current;
    if (batch?.phase === 'preparing') return;
    const liveProvider = useProviderStore.getState().providers.find((item) => item.id === providerId);
    const liveFingerprint = modelTestFingerprint(liveProvider, useSettingsStore.getState().settings);
    if (liveFingerprint === resultFingerprint.current) return;
    resultFingerprint.current = liveFingerprint;
    if (batch) { batch.invalidated = true; void stop(); }
    setResults(new Map());
    setFirstTextTimes(new Map());
    setDoneCount(0);
  }, [fingerprint, providerId, stop]);

  useEffect(() => {
    setPanelOpen(false);
    setSelectedModelId('');
    setGroupName(null);
    setResults(new Map());
    setFirstTextTimes(new Map());
    setDoneCount(0);
    return () => {
      const batch = batchRef.current;
      if (batch) { batch.invalidated = true; batch.cancelled = true; void requestCancel(batch); }
    };
  }, [providerId, requestCancel]);

  const promptDirty = (promptDraft.trim() || null) !== (savedPrompt?.trim() || null);
  const promptTooLong = [...promptDraft.trim()].length > (config?.max_prompt_chars ?? 2000);
  const supportedModels = useMemo(() => (provider?.models ?? []).filter((model) => {
    const kind = modelTestKind(model);
    return kind && provider && adapterSupportsKind(config, provider.provider_type, kind);
  }), [provider, config]);
  const targetModels = useMemo(() => {
    const source = supportedModels.filter((model) => panelMode === 'single'
      ? model.model_id === selectedModelId
      : panelMode !== 'group' || getModelGroupName(model) === groupName);
    return panelMode !== 'single' && scope === 'enabled' ? source.filter((model) => model.enabled) : source;
  }, [supportedModels, panelMode, selectedModelId, groupName, scope]);

  const executeQueue = async (batch: Batch, models: Model[], snapshot: ProviderConfig, prompt: string) => {
    const executeModel = async (model: Model) => {
      const testId = crypto.randomUUID();
      const current = { id: testId, registered: false, cancelling: false };
      batch.inFlight.set(testId, current);
      const kind = modelTestKind(model);
      const base = pendingModelTestResult(snapshot.id, model.model_id, testId);
      let result: ModelTestResult;
      if (!kind || !adapterSupportsKind(config, snapshot.provider_type, kind)) {
        result = { ...base, status: 'unsupported', error_code: 'unsupported' };
      } else {
        setRunningModelIds((prev) => new Set(prev).add(model.model_id));
        const profile = resolveReasoningProfile(snapshot.provider_type, model);
        try {
          result = await runModelTest({
            testId, providerId: snapshot.id, modelId: model.model_id,
            prompt: kind === 'chat' ? prompt : null,
            thinkingLevel: kind === 'chat' && supportsReasoning(model)
              ? coerceReasoningOptionKey(profile, profile.defaultOptionKey) : null,
            onEvent: (event) => {
              if (event.test_id !== testId) return;
              if (event.type === 'registered') {
                current.registered = true;
                if (batch.cancelled) void requestCancel(batch);
              }
              if (event.type === 'first_text' && mountedRef.current && !batch.invalidated
                && batchRef.current === batch && batch.inFlight.get(testId) === current) {
                setFirstTextTimes((prev) => new Map(prev).set(model.model_id, event.first_text_ms));
              }
            },
          });
        } catch (error) {
          result = { ...base, status: 'failed', error_code: 'provider', error_detail: String(error) };
        }
      }
      batch.inFlight.delete(testId);
      if (!mountedRef.current || batch.invalidated) return;
      setRunningModelIds((prev) => new Set([...prev].filter((id) => id !== model.model_id)));
      setResults((prev) => new Map(prev).set(model.model_id, result));
      setActiveIds((prev) => new Set([...prev].filter((id) => id !== model.model_id)));
      setDoneCount((count) => count + 1);
    };
    let nextIndex = 0;
    const worker = async () => {
      while (!batch.cancelled && nextIndex < models.length) {
        const model = models[nextIndex++];
        await executeModel(model);
      }
    };
    const concurrency = execution === 'parallel' ? MODEL_TEST_PARALLEL_LIMIT : 1;
    const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, models.length) }, worker));
    const failure = settled.find((item) => item.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };

  const begin = async (requested: Model[], saveDraft: boolean) => {
    if (batchRef.current || savingRef.current || !config || configLoading || requested.length === 0) return;
    if (!isTauri()) { message.error(t('settings.modelTest.browserDisabled')); return; }
    const batch: Batch = { cancelled: false, invalidated: false, phase: 'preparing', inFlight: new Map() };
    batchRef.current = batch;
    setRunning(true); setPreparing(true); setStopping(false);
    let models: Model[] = [];
    try {
      const prompt = normalizeModelTestPrompt(saveDraft ? promptDraft : savedPrompt);
      await flushPendingEdits();
      if (batch.cancelled) return;
      if (saveDraft && promptDirty) await saveSettings({ model_test_prompt: prompt }, { throwOnError: true });
      if (batch.cancelled) return;
      const snapshot = useProviderStore.getState().providers.find((item) => item.id === providerId);
      if (!snapshot) throw new Error(t('settings.selectProvider'));
      models = requested.map((model) => snapshot.models.find((item) => item.model_id === model.model_id))
        .filter((model): model is Model => {
          const kind = model && modelTestKind(model);
          return !!kind && adapterSupportsKind(config, snapshot.provider_type, kind);
        });
      resultFingerprint.current = modelTestFingerprint(snapshot, useSettingsStore.getState().settings);
      batch.phase = 'running';
      setPreparing(false); setDoneCount(0);
      setActiveIds(new Set(models.map((model) => model.model_id)));
      setResults((prev) => new Map([...prev].filter(([id]) => !models.some((model) => model.model_id === id))));
      setFirstTextTimes(new Map());
      await executeQueue(batch, models, snapshot, prompt ?? config.default_prompt);
    } catch (error) {
      message.error(`${t('error.saveFailed')}: ${String(error)}`);
    } finally {
      if (mountedRef.current && !batch.invalidated && batch.cancelled) {
        setResults((prev) => {
          const next = new Map(prev);
          models.forEach((model) => {
            if (!next.has(model.model_id)) next.set(model.model_id, pendingModelTestResult(providerId, model.model_id, ''));
          });
          return next;
        });
      }
      if (batchRef.current === batch) batchRef.current = null;
      if (mountedRef.current) {
        setRunning(false); setPreparing(false); setStopping(false);
        setActiveIds(new Set()); setRunningModelIds(new Set());
      }
    }
  };

  const openPanel = (mode: ModelTestPanelMode, models?: Model[]) => {
    if (batchRef.current) return;
    setPanelMode(mode); setScope('all');
    if (mode === 'group') setGroupName(models?.[0] ? getModelGroupName(models[0]) : null);
    if (mode === 'single') setSelectedModelId(models?.[0]?.model_id ?? '');
    setPanelOpen(true);
  };

  const savePrompt = async () => {
    if (batchRef.current || savingRef.current || !config) return;
    savingRef.current = true;
    setPreparing(true);
    try {
      const prompt = normalizeModelTestPrompt(promptDraft);
      await saveSettings({ model_test_prompt: prompt }, { throwOnError: true });
    } catch (error) {
      message.error(`${t('error.saveFailed')}: ${String(error)}`);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setPreparing(false);
    }
  };

  return {
    config, configError, configLoading, reloadConfig, panelOpen, panelMode, scope, setScope, execution, setExecution,
    promptDraft, setPromptDraft, promptDirty, promptTooLong, selectedModelId, setSelectedModelId,
    supportedModels, targetModels, running, preparing, stopping, results, activeIds, firstTextTimes, runningModelIds, doneCount,
    openPanel, start: () => begin(targetModels, true), stop, savePrompt,
    testInline: (model: Model) => begin([model], false),
    restoreDefault: () => setPromptDraft(''),
    closePanel: () => { void stop(); setPanelOpen(false); },
  };
}
