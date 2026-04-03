import {
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Popover,
  Select,
  Slider,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  App,
  theme,
} from 'antd';
import { Maximize2, Mic, Lightbulb, Copy, Database, Trash2, Eye, Heart, Key, MessageSquare, Plus, RefreshCw, Search, Settings, Minimize2, Wrench, Undo2, CircleHelp, ChevronRight, ChevronDown, Expand, Shrink } from 'lucide-react';
import { ModelIcon } from '@lobehub/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { useProviderStore, useUIStore } from '@/stores';
import { SmartProviderIcon } from '@/lib/providerIcons';
import { getEditableCapabilities, getVisibleModelCapabilities, sanitizeModelCapabilities } from '@/lib/modelCapabilities';
import { IconEditor } from '@/components/shared/IconEditor';
import { DynamicLobeIcon } from '@/components/shared/DynamicLobeIcon';
import type { Model, ModelCapability, ModelType, ModelParamOverrides, ProviderType } from '@/types';
import { ModelParamSliders } from '@/components/common/ModelParamSliders';

const { Text, Title } = Typography;

const CAPABILITY_LABEL_KEYS: Record<ModelCapability, string> = {
  TextChat: 'settings.capability.TextChat',
  Vision: 'settings.capability.Vision',
  FunctionCalling: 'settings.capability.FunctionCalling',
  Reasoning: 'settings.capability.Reasoning',
  RealtimeVoice: 'settings.capability.RealtimeVoice',
};

const CAPABILITY_COLORS: Record<ModelCapability, string> = {
  TextChat: 'blue',
  Vision: 'green',
  FunctionCalling: 'purple',
  Reasoning: 'orange',
  RealtimeVoice: 'red',
};

const CAPABILITY_ICONS: Record<ModelCapability, React.ReactNode> = {
  TextChat: <MessageSquare size={14} />,
  Vision: <Eye size={14} />,
  FunctionCalling: <Wrench size={14} />,
  Reasoning: <Lightbulb size={14} />,
  RealtimeVoice: <Mic size={14} />,
};

const MODEL_TYPE_LABEL_KEYS: Record<ModelType, string> = {
  Chat: 'settings.modelType.Chat',
  Voice: 'settings.modelType.Voice',
  Embedding: 'settings.modelType.Embedding',
};

const MODEL_TYPE_CONFIG: Record<ModelType, { color: string; icon: React.ReactNode }> = {
  Chat: { color: 'blue', icon: <MessageSquare size={12} /> },
  Voice: { color: 'red', icon: <Mic size={12} /> },
  Embedding: { color: 'cyan', icon: <Database size={12} /> },
};

const DEFAULT_PATHS: Record<ProviderType, string> = {
  openai: '/v1/chat/completions',
  openai_responses: '/v1/responses',
  anthropic: '/v1/messages',
  gemini: '/v1beta/models',
  custom: '/v1/chat/completions',
};

const DEFAULT_HOSTS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com',
  openai_responses: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  custom: '',
};

function deriveModelGroupName(modelId: string): string {
  const parts = modelId
    .trim()
    .split('-')
    .filter((part) => part.length > 0);

  if (parts.length >= 2) return parts.slice(0, 2).join('-');
  if (parts.length === 1) return parts[0];
  return modelId.trim();
}

function getModelGroupName(model: Pick<Model, 'model_id' | 'group_name'>): string {
  const explicitGroup = model.group_name?.trim();
  return explicitGroup || deriveModelGroupName(model.model_id);
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    const m = tokens / 1000000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return `${tokens}`;
}

function getDefaultCapabilitiesForType(modelType: ModelType): ModelCapability[] {
  switch (modelType) {
    case 'Voice':
      return ['RealtimeVoice'];
    case 'Embedding':
      return [];
    case 'Chat':
    default:
      return ['TextChat'];
  }
}

interface ProviderDetailProps {
  providerId: string;
}

export function ProviderDetail({ providerId }: ProviderDetailProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  const provider = useProviderStore((s) =>
    s.providers.find((p) => p.id === providerId),
  );
  const toggleProvider = useProviderStore((s) => s.toggleProvider);
  const updateProvider = useProviderStore((s) => s.updateProvider);
  const deleteProvider = useProviderStore((s) => s.deleteProvider);
  const setSelectedProviderId = useUIStore((s) => s.setSelectedProviderId);
  const addProviderKey = useProviderStore((s) => s.addProviderKey);
  const deleteProviderKey = useProviderStore((s) => s.deleteProviderKey);
  const toggleProviderKey = useProviderStore((s) => s.toggleProviderKey);
  const validateProviderKey = useProviderStore((s) => s.validateProviderKey);
  const toggleModel = useProviderStore((s) => s.toggleModel);
  const updateModelParams = useProviderStore((s) => s.updateModelParams);
  const fetchRemoteModels = useProviderStore((s) => s.fetchRemoteModels);
  const saveModels = useProviderStore((s) => s.saveModels);
  const testModel = useProviderStore((s) => s.testModel);

  const [addKeyModal, setAddKeyModal] = useState(false);
  const [keyValue, setKeyValue] = useState('');
  const [validatingKeys, setValidatingKeys] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [showModelSearch, setShowModelSearch] = useState(false);
  const [addModelModalOpen, setAddModelModalOpen] = useState(false);
  const [addModelId, setAddModelId] = useState('');
  const [addModelName, setAddModelName] = useState('');
  const [addModelGroupName, setAddModelGroupName] = useState('');
  const [addModelType, setAddModelType] = useState<ModelType>('Chat');
  const addModelNameDirty = useRef(false);
  const addModelGroupDirty = useRef(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [editCapabilities, setEditCapabilities] = useState<ModelCapability[]>([]);
  const [editModelType, setEditModelType] = useState<ModelType>('Chat');
  const [editMaxTokens, setEditMaxTokens] = useState<number | null>(null);
  const [editTemperature, setEditTemperature] = useState<number | null>(0.7);
  const [editMaxTokensParam, setEditMaxTokensParam] = useState<number | null>(4096);
  const [editTopP, setEditTopP] = useState<number | null>(1.0);
  const [editFreqPenalty, setEditFreqPenalty] = useState<number | null>(0.0);
  const [editUseMaxCompletionTokens, setEditUseMaxCompletionTokens] = useState(false);
  const [editNoSystemRole, setEditNoSystemRole] = useState(false);
  const [editForceMaxTokens, setEditForceMaxTokens] = useState(false);
  const [iconOverrides, setIconOverrides] = useState<Record<string, string>>({});
  const [apiHostLocal, setApiHostLocal] = useState(provider?.api_host ?? '');
  const [apiPathLocal, setApiPathLocal] = useState(provider?.api_path ?? '');
  const [customHeadersLocal, setCustomHeadersLocal] = useState(() => {
    try {
      const obj = JSON.parse(provider?.custom_headers ?? '{}') as Record<string, string>;
      return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
    } catch { return ''; }
  });
  const apiHostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiPathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [testingModels, setTestingModels] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Map<string, { latencyMs?: number; error?: string }>>(new Map());
  const [singleTestModalOpen, setSingleTestModalOpen] = useState(false);
  const [singleTestModelId, setSingleTestModelId] = useState<string>('');
  const [singleTestResult, setSingleTestResult] = useState<{ latencyMs?: number; error?: string } | null>(null);
  const [singleTestLoading, setSingleTestLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerModels, setPickerModels] = useState<Model[]>([]);
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerCollapsed, setPickerCollapsed] = useState<Set<string>>(new Set());

  const pickerGroups = useMemo(() => {
    const filtered = pickerModels.filter((m) =>
      !pickerSearch || [m.name, m.model_id].some((v) => v.toLowerCase().includes(pickerSearch.toLowerCase())),
    );
    const groups: Record<string, Model[]> = {};
    for (const m of filtered) {
      const key = getModelGroupName(m);
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }
    return { filtered, entries: Object.entries(groups) };
  }, [pickerModels, pickerSearch]);

  // Flatten picker groups into virtual rows
  type PickerRow = { type: 'group'; group: string; models: Model[] } | { type: 'model'; model: Model } | { type: 'spacer'; beforeGroup: string };
  const flatPickerRows = useMemo<PickerRow[]>(() => {
    const rows: PickerRow[] = [];
    const entries = pickerGroups.entries;
    for (let i = 0; i < entries.length; i++) {
      const [group, models] = entries[i];
      if (i > 0) rows.push({ type: 'spacer', beforeGroup: group });
      rows.push({ type: 'group', group, models });
      if (!pickerCollapsed.has(group)) {
        for (const model of models) {
          rows.push({ type: 'model', model });
        }
      }
    }
    return rows;
  }, [pickerGroups.entries, pickerCollapsed]);

  const pickerListParentRef = useRef<HTMLDivElement>(null);
  const pickerVirtualizer = useVirtualizer({
    count: flatPickerRows.length,
    getScrollElement: () => pickerListParentRef.current,
    estimateSize: (index) => {
      const row = flatPickerRows[index];
      if (row.type === 'spacer') return 8;
      if (row.type === 'group') return 40;
      return 40;
    },
    getItemKey: (index) => {
      const row = flatPickerRows[index];
      if (row.type === 'spacer') return `spacer-${row.beforeGroup}`;
      if (row.type === 'group') return `group-${row.group}`;
      return `model-${row.model.model_id}`;
    },
    overscan: 15,
  });

  // Sync local state when provider changes (e.g. switching providers)
  useEffect(() => {
    setApiHostLocal(provider?.api_host ?? '');
    setApiPathLocal(provider?.api_path ?? '');
    try {
      const obj = JSON.parse(provider?.custom_headers ?? '{}') as Record<string, string>;
      setCustomHeadersLocal(Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n'));
    } catch { setCustomHeadersLocal(''); }
  }, [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve actual request URLs for preview
  const resolvedUrls = useMemo(() => {
    const providerType = provider?.provider_type ?? 'custom';
    const host = apiHostLocal || DEFAULT_HOSTS[providerType] || '';
    const path = apiPathLocal || DEFAULT_PATHS[providerType] || '';

    // Default version path per provider type
    const defaultVersion = providerType === 'gemini' ? '/v1beta' : '/v1';

    // Check if URL ends with a versioned path like /v1, /v1beta, /v2, etc.
    const hasVersionSuffix = (url: string) => {
      const lastSeg = url.split('/').pop() || '';
      return /^v\d/.test(lastSeg);
    };
    // Extract version prefix like "/v1", "/v1beta"
    const extractVersionPrefix = (url: string): string | null => {
      const lastSeg = url.split('/').pop() || '';
      return /^v\d/.test(lastSeg) ? `/${lastSeg}` : null;
    };

    // resolve base_url: strip trailing !, auto-add default version if missing
    const trimmed = host.replace(/\/+$/, '');
    const forced = trimmed.endsWith('!');
    const rawHost = forced ? trimmed.slice(0, -1).replace(/\/+$/, '') : trimmed;
    const resolvedBase = forced ? rawHost : hasVersionSuffix(rawHost) ? rawHost : `${rawHost}${defaultVersion}`;

    // resolve chat url: strip ! from path, dedup version prefix
    const pathForced = path.endsWith('!');
    const rawPath = pathForced ? path.slice(0, -1) : path;
    const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    let chatUrl: string;
    if (pathForced) {
      chatUrl = `${resolvedBase}${normalizedPath}`;
    } else {
      const ver = extractVersionPrefix(resolvedBase);
      if (ver && normalizedPath.startsWith(ver)) {
        chatUrl = `${resolvedBase}${normalizedPath.slice(ver.length)}`;
      } else {
        chatUrl = `${resolvedBase}${normalizedPath}`;
      }
    }

    return { resolvedBase, chatUrl };
  }, [apiHostLocal, apiPathLocal, provider?.provider_type]);

  const filteredModels = useMemo(
    () =>
      (provider?.models ?? []).filter((m) =>
        [m.name, m.model_id, getModelGroupName(m)]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(modelSearch.toLowerCase())),
      ),
    [provider?.models, modelSearch],
  );

  const handleOpenAddModel = useCallback((groupName?: string) => {
    setAddModelId('');
    setAddModelName('');
    setAddModelGroupName(groupName ?? '');
    setAddModelType('Chat');
    addModelNameDirty.current = false;
    addModelGroupDirty.current = !!groupName;
    setAddModelModalOpen(true);
  }, []);

  const handleAddKey = useCallback(async () => {
    if (!keyValue.trim()) return;
    try {
      await addProviderKey(providerId, keyValue);
      setKeyValue('');
      setAddKeyModal(false);
    } catch {
      message.error(t('error.saveFailed'));
    }
  }, [keyValue, providerId, addProviderKey, message, t]);

  const handleValidateKey = useCallback(
    async (keyId: string) => {
      setValidatingKeys((s) => new Set(s).add(keyId));
      try {
        const valid = await validateProviderKey(keyId);
        if (valid) {
          message.success(t('settings.keyValidSuccess'));
        } else {
          message.error(t('settings.keyInvalidError'));
        }
      } catch (e) {
        message.error(t('error.keyValidationFailed') + ': ' + String(e));
      } finally {
        setValidatingKeys((s) => {
          const next = new Set(s);
          next.delete(keyId);
          return next;
        });
      }
    },
    [validateProviderKey, message, t],
  );

  const handleRefreshModels = useCallback(async () => {
    setRefreshing(true);
    try {
      const models = await fetchRemoteModels(providerId);
      const existingIds = new Set((provider?.models ?? []).map((m) => m.model_id));
      const newModels = models.filter((m) => !existingIds.has(m.model_id));
      if (newModels.length === 0) {
        message.info(t('settings.noNewModels', '没有发现新模型'));
        return;
      }
      setPickerModels(newModels);
      setPickerSelected(new Set(newModels.map((m) => m.model_id)));
      setPickerSearch('');
      setPickerCollapsed(new Set());
      setPickerOpen(true);
    } catch (e) {
      const errMsg = String(e);
      if (errMsg.includes('No active key') || errMsg.includes('key')) {
        message.error(t('settings.noActiveKeyError'));
      } else {
        message.error(t('error.loadFailed') + ': ' + errMsg);
      }
    } finally {
      setRefreshing(false);
    }
  }, [providerId, fetchRemoteModels, provider?.models, message, t]);

  const handlePickerConfirm = useCallback(async () => {
    const selectedModels = pickerModels.filter((m) => pickerSelected.has(m.model_id));
    if (selectedModels.length === 0) {
      setPickerOpen(false);
      return;
    }
    const merged = [...(provider?.models ?? []), ...selectedModels];
    try {
      await saveModels(providerId, merged);
      message.success(t('settings.modelsAdded', { count: selectedModels.length }));
    } catch {
      message.error(t('error.saveFailed'));
    }
    setPickerOpen(false);
  }, [pickerModels, pickerSelected, provider?.models, providerId, saveModels, message, t]);

  const handleTestSingleModel = useCallback(async () => {
    if (!singleTestModelId) return;
    setSingleTestLoading(true);
    setSingleTestResult(null);
    try {
      const latencyMs = await testModel(providerId, singleTestModelId);
      setSingleTestResult({ latencyMs });
    } catch (e) {
      setSingleTestResult({ error: String(e) });
    } finally {
      setSingleTestLoading(false);
    }
  }, [providerId, singleTestModelId, testModel]);

  const handleTestInlineModel = useCallback(async (modelId: string) => {
    setTestingModels((prev) => new Set(prev).add(modelId));
    try {
      const latencyMs = await testModel(providerId, modelId);
      setTestResults((prev) => new Map(prev).set(modelId, { latencyMs }));
    } catch (e) {
      setTestResults((prev) => new Map(prev).set(modelId, { error: String(e) }));
    } finally {
      setTestingModels((prev) => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
    }
  }, [providerId, testModel]);

  const handleTestAllModels = useCallback(async () => {
    const models = provider?.models ?? [];
    if (models.length === 0) return;
    setTestResults(new Map());
    setTestingModels(new Set(models.map((m) => m.model_id)));
    for (const model of models) {
      try {
        const latencyMs = await testModel(providerId, model.model_id);
        setTestResults((prev) => new Map(prev).set(model.model_id, { latencyMs }));
      } catch (e) {
        setTestResults((prev) => new Map(prev).set(model.model_id, { error: String(e) }));
      } finally {
        setTestingModels((prev) => {
          const next = new Set(prev);
          next.delete(model.model_id);
          return next;
        });
      }
    }
  }, [provider?.models, providerId, testModel]);

  const handleAddModel = useCallback(async () => {
    const nextModelId = addModelId.trim();
    const nextModelName = addModelName.trim();
    const manualGroupName = addModelGroupName.trim();

    if (!nextModelId) {
      message.error(t('settings.modelIdRequired', '请先填写模型标识'));
      return;
    }

    const duplicateExists = (provider?.models ?? []).some((model) => model.model_id === nextModelId);
    if (duplicateExists) {
      message.error(t('settings.duplicateModelError', '模型标识已存在，请使用其他模型标识'));
      return;
    }

    const nextModel: Model = {
      provider_id: providerId,
      model_id: nextModelId,
      name: nextModelName || nextModelId,
      group_name: manualGroupName || deriveModelGroupName(nextModelId),
      model_type: addModelType,
      capabilities: getDefaultCapabilitiesForType(addModelType),
      max_tokens: null,
      enabled: true,
      param_overrides: null,
    };

    try {
      await saveModels(providerId, [...(provider?.models ?? []), nextModel]);
      setAddModelModalOpen(false);
      setAddModelId('');
      setAddModelName('');
      setAddModelGroupName('');
      setAddModelType('Chat');
    } catch {
      message.error(t('error.saveFailed'));
    }
  }, [addModelGroupName, addModelId, addModelName, addModelType, message, provider?.models, providerId, saveModels, t]);

  const handleOpenSettings = useCallback(
    (model: Model) => {
      setEditingModel(model);
      const nextModelType = model.model_type || 'Chat';
      setEditCapabilities(sanitizeModelCapabilities(nextModelType, model.capabilities));
      setEditModelType(nextModelType);
      setEditMaxTokens(model.max_tokens ?? 128000);
      setEditTemperature(model.param_overrides?.temperature ?? 0.7);
      setEditMaxTokensParam(model.param_overrides?.max_tokens ?? 4096);
      setEditTopP(model.param_overrides?.top_p ?? 1.0);
      setEditFreqPenalty(model.param_overrides?.frequency_penalty ?? 0.0);
      setEditUseMaxCompletionTokens(model.param_overrides?.use_max_completion_tokens ?? false);
      setEditNoSystemRole(model.param_overrides?.no_system_role ?? false);
      setEditForceMaxTokens(model.param_overrides?.force_max_tokens ?? false);
      setSettingsModalOpen(true);
    },
    [],
  );

  const handleSaveSettings = useCallback(async () => {
    if (!editingModel) return;
    const values: ModelParamOverrides = {
      temperature: editTemperature ?? undefined,
      max_tokens: editMaxTokensParam ?? undefined,
      top_p: editTopP ?? undefined,
      frequency_penalty: editFreqPenalty ?? undefined,
      use_max_completion_tokens: editUseMaxCompletionTokens,
      no_system_role: editNoSystemRole,
      force_max_tokens: editForceMaxTokens,
    };
    const nextCapabilities = sanitizeModelCapabilities(editModelType, editCapabilities);
    try {
      await updateModelParams(providerId, editingModel.model_id, values);
      // Update capabilities locally via saveModels
      const updatedModels = (provider?.models ?? []).map((m) =>
        m.model_id === editingModel.model_id
          ? { ...m, capabilities: nextCapabilities, model_type: editModelType, param_overrides: values, max_tokens: editMaxTokens }
          : m,
      );
      await saveModels(providerId, updatedModels);
      setSettingsModalOpen(false);
      setEditingModel(null);
    } catch {
      message.error(t('error.saveFailed'));
    }
  }, [editingModel, editCapabilities, editModelType, editMaxTokens, editTemperature, editMaxTokensParam, editTopP, editFreqPenalty, editUseMaxCompletionTokens, editNoSystemRole, editForceMaxTokens, providerId, updateModelParams, saveModels, provider?.models, message, t]);

  const handleApiHostChange = useCallback(
    (value: string) => {
      setApiHostLocal(value);
      if (apiHostTimerRef.current) clearTimeout(apiHostTimerRef.current);
      apiHostTimerRef.current = setTimeout(() => {
        updateProvider(providerId, { api_host: value });
      }, 500);
    },
    [providerId, updateProvider],
  );

  const handleApiPathChange = useCallback(
    (value: string) => {
      setApiPathLocal(value);
      if (apiPathTimerRef.current) clearTimeout(apiPathTimerRef.current);
      apiPathTimerRef.current = setTimeout(() => {
        updateProvider(providerId, { api_path: value || null });
      }, 500);
    },
    [providerId, updateProvider],
  );

  const groupedModels = useMemo(() => {
    const groups: Record<string, Model[]> = {};
    for (const model of filteredModels) {
      const groupKey = getModelGroupName(model);
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(model);
    }
    return groups;
  }, [filteredModels]);

  // Track expanded groups for collapse/expand all
  const groupKeys = useMemo(() => Object.keys(groupedModels), [groupedModels]);
  const modelGroupOptions = useMemo(
    () => groupKeys.map((group) => ({ value: group })),
    [groupKeys],
  );
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  useEffect(() => { setExpandedGroups(groupKeys); }, [groupKeys]);
  const allExpanded = expandedGroups.length >= groupKeys.length;
  const [modelListFullscreen, setModelListFullscreen] = useState(false);

  // Flatten grouped models into virtual rows
  type ModelListRow = { type: 'group'; group: string; models: Model[] } | { type: 'model'; model: Model; group: string } | { type: 'spacer'; beforeGroup: string };
  const flatModelRows = useMemo<ModelListRow[]>(() => {
    const rows: ModelListRow[] = [];
    const entries = Object.entries(groupedModels);
    for (let i = 0; i < entries.length; i++) {
      const [group, models] = entries[i];
      if (i > 0) rows.push({ type: 'spacer', beforeGroup: group });
      rows.push({ type: 'group', group, models });
      if (expandedGroups.includes(group)) {
        for (const model of models) {
          rows.push({ type: 'model', model, group });
        }
      }
    }
    return rows;
  }, [groupedModels, expandedGroups]);

  const modelListParentRef = useRef<HTMLDivElement>(null);
  const modelListVirtualizer = useVirtualizer({
    count: flatModelRows.length,
    getScrollElement: () => modelListParentRef.current,
    estimateSize: (index) => {
      const row = flatModelRows[index];
      if (row.type === 'spacer') return 8;
      if (row.type === 'group') return 40;
      return 44;
    },
    getItemKey: (index) => {
      const row = flatModelRows[index];
      if (row.type === 'spacer') return `spacer-${row.beforeGroup}`;
      if (row.type === 'group') return `group-${row.group}`;
      return `model-${row.model.model_id}`;
    },
    overscan: 10,
  });

  const handleRemoveModel = useCallback(async (modelId: string) => {
    const updatedModels = (provider?.models ?? []).filter((m) => m.model_id !== modelId);
    try {
      await saveModels(providerId, updatedModels);
    } catch {
      message.error(t('error.saveFailed'));
    }
  }, [provider?.models, providerId, saveModels, message, t]);

  if (!provider) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <IconEditor
            iconType={provider.icon ? 'model_icon' : null}
            iconValue={provider.icon ?? null}
            onChange={(type, value) => {
              if (type === 'model_icon' && value) {
                updateProvider(providerId, { icon: value });
              } else if (type === 'emoji' || type === 'url' || type === 'file') {
                updateProvider(providerId, { icon: `${type}:${value}` });
              } else {
                updateProvider(providerId, { icon: '' });
              }
            }}
            size={40}
            shape="square"
            defaultIcon={<SmartProviderIcon provider={provider} size={40} type="avatar" shape="square" />}
            showModelIcons
            modelIconsDefaultTab="provider"
          />
          <div>
            <div className="flex items-center gap-2">
              <Title level={4} className="!mb-0">
                {provider.name}
              </Title>
              <Select
                size="small"
                value={provider.provider_type}
                onChange={(val) => updateProvider(providerId, { provider_type: val as ProviderType })}
                style={{ minWidth: 140 }}
                options={[
                  { label: 'OpenAI', value: 'openai' },
                  { label: 'OpenAI Responses', value: 'openai_responses' },
                  { label: 'Anthropic', value: 'anthropic' },
                  { label: 'Gemini', value: 'gemini' },
                  { label: t('settings.custom', '自定义'), value: 'custom' },
                ]}
                popupMatchSelectWidth={false}
              />
            </div>
          </div>
        </div>
        <Space>
          <Switch
            checked={provider.enabled}
            onChange={(checked) => toggleProvider(providerId, checked)}
            checkedChildren={t('common.enabled')}
            unCheckedChildren={t('common.disabled')}
          />
          <Popconfirm
            title={t('settings.deleteProviderConfirm')}
            onConfirm={async () => {
              await deleteProvider(providerId);
              setSelectedProviderId(null);
            }}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
          >
            <Button danger icon={<Trash2 size={16} />} />
          </Popconfirm>
        </Space>
      </div>

      <Divider className="!my-2" />

      {/* API Keys */}
      <Card
        title={t('settings.apiKeys')}
        size="small"
        extra={
          <Button
            size="small"
            icon={<Plus size={14} />}
            onClick={() => setAddKeyModal(true)}
          >
            {t('settings.addKey')}
          </Button>
        }
      >
        {provider.keys.length === 0 ? (
          <Text type="secondary">{t('common.noData')}</Text>
        ) : (
          <Space direction="vertical" className="w-full" size="small">
            {provider.keys.map((key) => (
              <div
                key={key.id}
                className="flex items-center justify-between rounded-md px-3 py-2"
                style={{ border: '1px solid var(--border-color)' }}
              >
                <Space>
                  <Switch
                    size="small"
                    checked={key.enabled}
                    onChange={(checked) => toggleProviderKey(key.id, checked)}
                  />
                  <Key size={14} />
                  <Text code>{key.key_prefix}••••••••</Text>
                </Space>
                <Space size="small">
                  <Button
                    type="text"
                    size="small"
                    icon={<Heart size={14} />}
                    loading={validatingKeys.has(key.id)}
                    onClick={() => handleValidateKey(key.id)}
                    title={t('settings.validateKey')}
                  />
                  <Popconfirm
                    title={t('settings.deleteKeyConfirm')}
                    onConfirm={() => deleteProviderKey(key.id)}
                    okText={t('common.confirm')}
                    cancelText={t('common.cancel')}
                    okButtonProps={{ danger: true }}
                  >
                    <Button type="text" size="small" danger icon={<Trash2 size={14} />} />
                  </Popconfirm>
                </Space>
              </div>
            ))}
          </Space>
        )}
      </Card>

      {/* API Host + Path */}
      <Card title={t('settings.apiHost')} size="small">
        <Form layout="horizontal" colon={false} labelCol={{ flex: '110px' }} wrapperCol={{ flex: 1 }}>
          <Form.Item
            label={
              <Space size={4}>
                <span>Base URL</span>
                <Tooltip title={t('settings.urlHintExclamation')}>
                  <CircleHelp size={14} style={{ cursor: 'help' }} />
                </Tooltip>
              </Space>
            }
            style={{ marginBottom: 12 }}
          >
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={apiHostLocal}
                onChange={(e) => handleApiHostChange(e.target.value)}
                placeholder={DEFAULT_HOSTS[provider.provider_type]}
              />
              <Button
                icon={<Undo2 size={16} />}
                onClick={() => {
                  const defaultHost = DEFAULT_HOSTS[provider.provider_type];
                  setApiHostLocal(defaultHost);
                  updateProvider(providerId, { api_host: defaultHost });
                }}
              >
                {t('settings.resetDefault')}
              </Button>
            </Space.Compact>
            <div style={{ marginTop: 4, fontSize: 12, color: token.colorTextQuaternary }}>
              {t('settings.urlPreviewLabel')}{resolvedUrls.resolvedBase}
            </div>
          </Form.Item>
          <Form.Item
            label={
              <Space size={4}>
                <span>{t('settings.apiPath')}</span>
                <Tooltip title={t('settings.urlHintExclamation')}>
                  <CircleHelp size={14} style={{ cursor: 'help' }} />
                </Tooltip>
              </Space>
            }
            style={{ marginBottom: 0 }}
          >
            <Input
              value={apiPathLocal || DEFAULT_PATHS[provider.provider_type]}
              onChange={(e) => handleApiPathChange(e.target.value)}
              placeholder={DEFAULT_PATHS[provider.provider_type]}
            />
            <div style={{ marginTop: 4, fontSize: 12, color: token.colorTextQuaternary }}>
              {t('settings.urlPreviewLabel')}{resolvedUrls.chatUrl}
            </div>
          </Form.Item>
        </Form>
      </Card>

      {/* Models List */}
      {modelListFullscreen && (
        <div
          style={{ position: 'fixed', top: 37, left: 0, right: 0, bottom: 0, zIndex: 999, background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setModelListFullscreen(false)}
        />
      )}
      <Card
        style={modelListFullscreen ? { position: 'fixed', top: 47, left: 10, right: 10, bottom: 10, zIndex: 1000, overflow: 'auto', display: 'flex', flexDirection: 'column' } : undefined}
        title={
          <Space>
            <span>{t('settings.models')}</span>
            <Tag>{filteredModels.length}</Tag>
          </Space>
        }
        size="small"
        extra={
          <Space size={4}>
            <Tooltip title={t('settings.searchModels')}>
              <Button
                type="text"
                size="small"
                icon={<Search size={14} />}
                onClick={() => {
                  setShowModelSearch(!showModelSearch);
                  if (showModelSearch) setModelSearch('');
                }}
                style={{ color: showModelSearch ? token.colorPrimary : undefined }}
              />
            </Tooltip>
             <Tooltip title={t('settings.refreshModels')}>
                <Button
                  type="text"
                  size="small"
                  icon={<RefreshCw size={14} />}
                  loading={refreshing}
                  onClick={handleRefreshModels}
                />
              </Tooltip>
              <Tooltip title={t('settings.addModel', '添加模型')}>
                <Button
                  type="text"
                  size="small"
                  icon={<Plus size={14} />}
                  onClick={() => handleOpenAddModel()}
                />
              </Tooltip>
              <Dropdown
                menu={{
                  items: [
                    { key: 'single', label: t('settings.testSingleModel') },
                    { key: 'all', label: t('settings.testAllModels') },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'single') {
                      setSingleTestModelId('');
                      setSingleTestResult(null);
                      setSingleTestLoading(false);
                      setSingleTestModalOpen(true);
                    } else {
                      handleTestAllModels();
                    }
                  },
                }}
                trigger={['click']}
              >
                <Tooltip title={t('settings.testModels')}>
                  <Button type="text" size="small" icon={<Heart size={14} />} />
                </Tooltip>
              </Dropdown>
            <Tooltip title={allExpanded ? t('common.collapseAll') : t('common.expandAll')}>
              <Button
                type="text"
                size="small"
                icon={allExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                onClick={() => {
                  if (allExpanded) setExpandedGroups([]);
                  else setExpandedGroups(groupKeys);
                }}
              />
            </Tooltip>
            <Tooltip title={modelListFullscreen ? t('settings.exitFullscreen', '退出全屏') : t('settings.fullscreen', '全屏')}>
              <Button
                type="text"
                size="small"
                icon={modelListFullscreen ? <Shrink size={14} /> : <Expand size={14} />}
                onClick={() => setModelListFullscreen(!modelListFullscreen)}
              />
            </Tooltip>
          </Space>
        }
      >
        {showModelSearch && (
          <Input
            prefix={<Search size={14} />}
            placeholder={t('settings.searchModels')}
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            allowClear
            size="small"
            style={{ marginBottom: 12 }}
            autoFocus
          />
        )}
        <div
          ref={modelListParentRef}
          style={{ maxHeight: modelListFullscreen ? 'calc(100vh - 140px)' : 520, overflow: 'auto' }}
        >
          <div style={{ height: modelListVirtualizer.getTotalSize(), position: 'relative' }}>
            {modelListVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = flatModelRows[virtualRow.index];
              if (row.type === 'spacer') {
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={modelListVirtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 8, transform: `translateY(${virtualRow.start}px)` }}
                  />
                );
              }
              if (row.type === 'group') {
                const { group, models } = row;
                const allEnabled = models.every((m) => m.enabled);
                const someEnabled = models.some((m) => m.enabled);
                const isExpanded = expandedGroups.includes(group);
                return (
                  <div
                    key={`g-${group}`}
                    data-index={virtualRow.index}
                    ref={modelListVirtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <div
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                      style={{ cursor: 'pointer', userSelect: 'none', background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))' }}
                      onClick={() => {
                        if (isExpanded) setExpandedGroups((prev) => prev.filter((k) => k !== group));
                        else setExpandedGroups((prev) => [...prev, group]);
                      }}
                    >
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <ModelIcon model={models[0]?.model_id ?? group} size={20} type="avatar" />
                      <Text style={{ fontWeight: 600 }}>{group}</Text>
                      <Tag style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>{models.length}</Tag>
                      <div style={{ flex: 1 }} />
                      <Space size="small" onClick={(e) => e.stopPropagation()}>
                        <Tooltip title={t('settings.addModelToGroup', '添加到当前分组')}>
                          <Button size="small" type="text" icon={<Plus size={14} />} onClick={() => handleOpenAddModel(group)} />
                        </Tooltip>
                        <Tooltip title={t('settings.testGroup', '检测当前分组')}>
                          <Button
                            size="small"
                            type="text"
                            icon={<Heart size={14} />}
                            loading={models.some((m) => testingModels.has(m.model_id))}
                            onClick={() => {
                              for (const m of models) {
                                handleTestInlineModel(m.model_id);
                              }
                            }}
                          />
                        </Tooltip>
                        <Switch
                          size="small"
                          checked={someEnabled}
                          style={someEnabled && !allEnabled ? { backgroundColor: token.colorWarning } : undefined}
                          onChange={(checked) => { models.forEach((m) => toggleModel(providerId, m.model_id, checked)); }}
                        />
                        <Popconfirm
                          title={t('settings.deleteGroupConfirm')}
                          onConfirm={async () => {
                            const modelIds = new Set(models.map((m) => m.model_id));
                            const updatedModels = (provider?.models ?? []).filter((m) => !modelIds.has(m.model_id));
                            try {
                              await saveModels(providerId, updatedModels);
                            } catch {
                              message.error(t('error.saveFailed'));
                            }
                          }}
                          okText={t('common.confirm')}
                          cancelText={t('common.cancel')}
                          okButtonProps={{ danger: true }}
                        >
                          <Button size="small" type="text" danger icon={<Trash2 size={14} />} />
                        </Popconfirm>
                      </Space>
                    </div>
                  </div>
                );
              }
              // model row
              const { model } = row;
              return (
                <div
                  key={`m-${model.model_id}`}
                  data-index={virtualRow.index}
                  ref={modelListVirtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                    style={{ opacity: model.enabled ? 1 : 0.45, paddingLeft: 36 }}
                  >
                    {iconOverrides[model.model_id]
                      ? <DynamicLobeIcon iconId={iconOverrides[model.model_id]} size={20} type="avatar" />
                      : <ModelIcon model={model.model_id} size={20} type="avatar" />
                    }
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span>{model.name || model.model_id}</span>
                        {model.name && model.name !== model.model_id && (
                          <Text type="secondary" style={{ fontSize: 11 }}>({model.model_id})</Text>
                        )}
                        <Tag
                          color={MODEL_TYPE_CONFIG[model.model_type || 'Chat'].color}
                          bordered={false}
                          style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}
                        >
                          {MODEL_TYPE_CONFIG[model.model_type || 'Chat'].icon}
                          <span style={{ marginLeft: 2 }}>{t(`settings.modelType.${model.model_type || 'Chat'}`, MODEL_TYPE_LABEL_KEYS[model.model_type || 'Chat'])}</span>
                        </Tag>
                        {getVisibleModelCapabilities(model).map((cap) => (
                          <Tooltip key={cap} title={t(`settings.capability.${cap}`, CAPABILITY_LABEL_KEYS[cap])}>
                            <Tag color={CAPABILITY_COLORS[cap]} bordered={false} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
                              {CAPABILITY_ICONS[cap]}
                            </Tag>
                          </Tooltip>
                        ))}
                        {model.max_tokens != null && model.max_tokens > 0 && (
                          <Tag bordered={false} color="default" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
                            {formatTokenCount(model.max_tokens)}
                          </Tag>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1" style={{ flexShrink: 0 }}>
                      {testingModels.has(model.model_id) && <Spin size="small" />}
                      {!testingModels.has(model.model_id) && testResults.has(model.model_id) && (() => {
                        const result = testResults.get(model.model_id)!;
                        if (result.latencyMs != null) {
                          return <span style={{ fontSize: 11, color: token.colorSuccess }}>{(result.latencyMs / 1000).toFixed(1)}s</span>;
                        }
                        return (
                          <Popover content={<div style={{ maxWidth: 300, wordBreak: 'break-all' }}>{result.error}</div>} title={t('common.errorDetail')} trigger="click">
                            <span style={{ fontSize: 11, color: token.colorError, cursor: 'pointer' }}>{t('common.failed')}</span>
                          </Popover>
                        );
                      })()}
                      <Switch size="small" checked={model.enabled} onChange={(checked) => toggleModel(providerId, model.model_id, checked)} />
                      <Button type="text" size="small" icon={<Settings size={14} />} onClick={() => handleOpenSettings(model)} />
                      <Tooltip title={t('settings.testModels')}>
                        <Button type="text" size="small" icon={<Heart size={14} />} loading={testingModels.has(model.model_id)} onClick={() => handleTestInlineModel(model.model_id)} />
                      </Tooltip>
                      <Popconfirm
                        title={t('settings.removeModelConfirm')}
                        onConfirm={() => handleRemoveModel(model.model_id)}
                        okText={t('common.confirm')}
                        cancelText={t('common.cancel')}
                        okButtonProps={{ danger: true }}
                      >
                        <Button type="text" size="small" danger icon={<Trash2 size={14} />} />
                      </Popconfirm>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {/* Custom Headers */}
      <Collapse
        items={[
          {
            key: 'custom-headers',
            label: t('settings.customHeaders'),
            children: (
              <Input.TextArea
                value={customHeadersLocal}
                onChange={(e) => setCustomHeadersLocal(e.target.value)}
                onBlur={() => {
                  const lines = customHeadersLocal.split('\n').filter((l) => l.trim());
                  const obj: Record<string, string> = {};
                  for (const line of lines) {
                    const idx = line.indexOf('=');
                    if (idx > 0) {
                      obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                    }
                  }
                  const json = Object.keys(obj).length > 0 ? JSON.stringify(obj) : null;
                  updateProvider(providerId, { custom_headers: json });
                }}
                placeholder={t('settings.customHeadersPlaceholder')}
                autoSize={{ minRows: 2, maxRows: 8 }}
              />
            ),
          },
        ]}
      />

      {/* Provider Proxy */}
      <Collapse
        items={[
          {
            key: 'proxy',
            label: t('settings.providerProxy'),
            children: (
              <Form layout="vertical" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Form.Item label={t('settings.proxyType')} style={{ marginBottom: 0 }}>
                  <Select
                    value={provider.proxy_config?.proxy_type ?? 'none'}
                    onChange={(val) =>
                      updateProvider(providerId, {
                        proxy_config: {
                          proxy_type: val === 'none' ? null : val,
                          proxy_address: provider.proxy_config?.proxy_address ?? null,
                          proxy_port: provider.proxy_config?.proxy_port ?? null,
                        },
                      })
                    }
                    options={[
                      { label: t('settings.proxyNone'), value: 'none' },
                      { label: 'HTTP', value: 'http' },
                      { label: 'SOCKS5', value: 'socks5' },
                    ]}
                  />
                </Form.Item>
                <Form.Item label={t('settings.proxyAddress')} style={{ marginBottom: 0 }}>
                  <Input
                    value={provider.proxy_config?.proxy_address ?? ''}
                    onChange={(e) =>
                      updateProvider(providerId, {
                        proxy_config: {
                          ...provider.proxy_config,
                          proxy_type: provider.proxy_config?.proxy_type ?? null,
                          proxy_address: e.target.value || null,
                          proxy_port: provider.proxy_config?.proxy_port ?? null,
                        },
                      })
                    }
                    placeholder="127.0.0.1"
                  />
                </Form.Item>
                <Form.Item label={t('settings.proxyPort')} style={{ marginBottom: 0 }}>
                  <InputNumber
                    value={provider.proxy_config?.proxy_port}
                    onChange={(val) =>
                      updateProvider(providerId, {
                        proxy_config: {
                          ...provider.proxy_config,
                          proxy_type: provider.proxy_config?.proxy_type ?? null,
                          proxy_address: provider.proxy_config?.proxy_address ?? null,
                          proxy_port: val ?? null,
                        },
                      })
                    }
                    placeholder="7890"
                    min={1}
                    max={65535}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Form>
            ),
          },
        ]}
      />

      {/* Add Key Modal */}
      <Modal
        title={t('settings.addKey')}
        open={addKeyModal}
        mask={{ enabled: true, blur: true }}
        onOk={handleAddKey}
        onCancel={() => {
          setAddKeyModal(false);
          setKeyValue('');
        }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        >
          <Input.Password
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            placeholder="sk-..."
          />
      </Modal>

      <Modal
        title={t('settings.addModel', '添加模型')}
        open={addModelModalOpen}
        mask={{ enabled: true, blur: true }}
        onCancel={() => {
          setAddModelModalOpen(false);
          setAddModelId('');
          setAddModelName('');
          setAddModelGroupName('');
          setAddModelType('Chat');
        }}
        onOk={handleAddModel}
        okText={t('settings.addModel', '添加模型')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label={t('settings.modelId')} required>
            <Input
              value={addModelId}
              onChange={(e) => {
                const id = e.target.value;
                setAddModelId(id);
                if (!addModelNameDirty.current) {
                  setAddModelName(id);
                }
                if (!addModelGroupDirty.current) {
                  setAddModelGroupName(id.trim() ? deriveModelGroupName(id) : '');
                }
              }}
              placeholder="gpt-5.4-think"
            />
          </Form.Item>
          <Form.Item label={t('settings.modelName')}>
            <Input
              value={addModelName}
              onChange={(e) => {
                addModelNameDirty.current = true;
                setAddModelName(e.target.value);
              }}
              placeholder="GPT 5.4 Think"
            />
          </Form.Item>
          <Form.Item label={t('settings.modelGroup', '模型分组')}>
            <AutoComplete
              value={addModelGroupName}
              onChange={(val) => {
                addModelGroupDirty.current = true;
                setAddModelGroupName(val);
              }}
              options={modelGroupOptions}
              placeholder={addModelId.trim() ? deriveModelGroupName(addModelId) : t('settings.modelGroupAuto', '留空时将按模型标识自动生成分组')}
            />
          </Form.Item>
          <Form.Item label={t('settings.modelType.title')} style={{ marginBottom: 0 }}>
            <Select
              value={addModelType}
              onChange={(value) => setAddModelType(value as ModelType)}
              options={(Object.keys(MODEL_TYPE_CONFIG) as ModelType[]).map((type_) => ({
                value: type_,
                label: t(`settings.modelType.${type_}`, MODEL_TYPE_LABEL_KEYS[type_]),
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Model Settings Modal */}
      <Modal
        title={t('settings.modelSettings')}
        open={settingsModalOpen}
        mask={{ enabled: true, blur: true }}
        onCancel={() => {
          setSettingsModalOpen(false);
          setEditingModel(null);
        }}
        onOk={handleSaveSettings}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        width={520}
        destroyOnHidden
      >
        {editingModel && (
          <div data-os-scrollbar style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
          <div className="space-y-3">
            {/* Model Icon + Name + ID */}
            <div className="flex items-center gap-3">
              <IconEditor
                iconType={iconOverrides[editingModel.model_id] ? 'model_icon' : null}
                iconValue={iconOverrides[editingModel.model_id] ? `model:${iconOverrides[editingModel.model_id]}` : null}
                onChange={(type, value) => {
                  if (editingModel) {
                    if (type === 'model_icon' && value) {
                      const iconId = value.indexOf(':') > 0 ? value.substring(value.indexOf(':') + 1) : value;
                      setIconOverrides((prev) => ({ ...prev, [editingModel.model_id]: iconId }));
                    } else {
                      // Clear override for non-model_icon types (or clear)
                      setIconOverrides((prev) => {
                        const next = { ...prev };
                        delete next[editingModel.model_id];
                        return next;
                      });
                    }
                  }
                }}
                size={32}
                showModelIcons
                showClear={!!iconOverrides[editingModel.model_id]}
                defaultIcon={<ModelIcon model={editingModel.model_id} size={32} type="avatar" />}
              />
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <span className="font-medium truncate">{editingModel.name || editingModel.model_id}</span>
                {editingModel.name && (
                  <span className="text-xs shrink-0" style={{ color: token.colorTextSecondary }}>({editingModel.model_id})</span>
                )}
                <Button
                  type="text"
                  size="small"
                  className="shrink-0"
                  icon={<Copy size={12} />}
                  onClick={() => {
                    navigator.clipboard.writeText(editingModel.model_id);
                    message.success(t('common.copySuccess'));
                  }}
                />
              </div>
            </div>

            <Divider className="!my-2" />

            {/* Model Type */}
            <div>
              <div className="font-medium mb-1.5" style={{ fontSize: 13 }}>{t('settings.modelType.title', '模型类型')}</div>
              <div className="flex gap-2 flex-wrap">
                {(Object.keys(MODEL_TYPE_CONFIG) as ModelType[]).map((type_) => (
                  <Tag
                    key={type_}
                    color={editModelType === type_ ? MODEL_TYPE_CONFIG[type_].color : 'default'}
                    style={{ cursor: 'pointer', fontSize: 12 }}
                    onClick={() => {
                      setEditModelType(type_);
                      setEditCapabilities((current) => sanitizeModelCapabilities(type_, current));
                    }}
                  >
                    {MODEL_TYPE_CONFIG[type_].icon}
                    <span style={{ marginLeft: 4 }}>{t(`settings.modelType.${type_}`, MODEL_TYPE_LABEL_KEYS[type_])}</span>
                  </Tag>
                ))}
              </div>
            </div>

            {editModelType === 'Chat' && (
              <>
                <Divider className="!my-2" />

                {/* Capabilities as clickable tags */}
                <div>
                  <div className="font-medium mb-1.5" style={{ fontSize: 13 }}>{t('settings.modelAbilities')}</div>
                  <div className="flex gap-2 flex-wrap">
                    {getEditableCapabilities(editModelType).map((cap) => {
                      const selected = editCapabilities.includes(cap);
                      return (
                        <Tag
                          key={cap}
                          color={selected ? CAPABILITY_COLORS[cap] : 'default'}
                          style={{ cursor: 'pointer', fontSize: 12, opacity: selected ? 1 : 0.6 }}
                          onClick={() => {
                            const next = selected
                              ? editCapabilities.filter((c) => c !== cap)
                              : [...editCapabilities, cap];
                            setEditCapabilities(sanitizeModelCapabilities(editModelType, next));
                          }}
                        >
                          {CAPABILITY_ICONS[cap]}
                          <span style={{ marginLeft: 4 }}>{t(`settings.capability.${cap}`, CAPABILITY_LABEL_KEYS[cap])}</span>
                        </Tag>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            <Divider className="!my-2" />

            {/* Parameters — horizontal label-control layout */}
            <div>
              <div className="font-medium mb-2" style={{ fontSize: 13 }}>{t('settings.modelParams')}</div>
              <div className="space-y-3">
                {/* Context Window */}
                <div>
                  <div className="flex items-center justify-between" style={{ padding: '8px 0' }}>
                    <span className="text-sm shrink-0" style={{ color: token.colorText }}>{t('settings.contextWindow')}</span>
                    <InputNumber
                      value={editMaxTokens}
                      onChange={(v) => v != null && setEditMaxTokens(v)}
                      min={1024}
                      step={1024}
                      style={{ width: 110 }}
                      size="small"
                      formatter={(v) => v ? `${Number(v).toLocaleString()}` : ''}
                    />
                  </div>
                  <div style={{ paddingBottom: 8 }}>
                    <Slider
                      min={1024}
                      max={1048576}
                      step={1024}
                      marks={{ 1024: '', 32768: '32K', 131072: '128K', 524288: '512K', 1048576: '1M' }}
                      value={Math.min(editMaxTokens ?? 128000, 1048576)}
                      onChange={(v) => setEditMaxTokens(v)}
                    />
                  </div>
                </div>

                <ModelParamSliders
                  values={{
                    temperature: editTemperature,
                    topP: editTopP,
                    maxTokens: editMaxTokensParam,
                    frequencyPenalty: editFreqPenalty,
                  }}
                  onChange={(v) => {
                    if ('temperature' in v) setEditTemperature(v.temperature!);
                    if ('topP' in v) setEditTopP(v.topP!);
                    if ('maxTokens' in v) setEditMaxTokensParam(v.maxTokens!);
                    if ('frequencyPenalty' in v) setEditFreqPenalty(v.frequencyPenalty!);
                  }}
                  showDividers={false}
                />

                <Divider className="!my-2" />

                {/* Switches — horizontal */}
                <div className="flex items-center justify-between">
                  <span className="text-sm" style={{ color: token.colorText }}>{t('settings.useMaxCompletionTokens', '使用 max_completion_tokens')}</span>
                  <Switch size="small" checked={editUseMaxCompletionTokens} onChange={setEditUseMaxCompletionTokens} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm" style={{ color: token.colorText }}>{t('settings.noSystemRole', '不支持 System 角色')}</span>
                  <Switch size="small" checked={editNoSystemRole} onChange={setEditNoSystemRole} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm" style={{ color: token.colorText }}>{t('settings.forceMaxTokens', '强制 Max Tokens')}</span>
                  <Switch size="small" checked={editForceMaxTokens} onChange={setEditForceMaxTokens} />
                </div>
              </div>
            </div>
          </div>
          </div>
        )}
      </Modal>

      {/* Single Model Test Modal */}
      <Modal
        title={t('settings.testSingleModel')}
        open={singleTestModalOpen}
        onCancel={() => setSingleTestModalOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setSingleTestModalOpen(false)}>
            {t('common.cancel')}
          </Button>,
          <Button
            key="test"
            type="primary"
            loading={singleTestLoading}
            disabled={!singleTestModelId}
            onClick={handleTestSingleModel}
          >
            {t('settings.startTest')}
          </Button>,
        ]}
      >
        <Form layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label={t('settings.selectModel')}>
            <Select
              showSearch
              value={singleTestModelId || undefined}
              onChange={setSingleTestModelId}
              placeholder={t('settings.selectModel')}
              optionFilterProp="label"
              options={(provider?.models ?? []).map((m) => ({
                label: m.name || m.model_id,
                value: m.model_id,
              }))}
            />
          </Form.Item>
        </Form>
        {singleTestResult && (
          <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 6, background: token.colorBgLayout }}>
            {singleTestResult.latencyMs != null ? (
              <span style={{ color: token.colorSuccess }}>
                ✓ {t('settings.testSuccess')} — {(singleTestResult.latencyMs / 1000).toFixed(2)}s
              </span>
            ) : (
              <div>
                <span style={{ color: token.colorError }}>✗ {t('common.failed')}</span>
                <div style={{ marginTop: 4, fontSize: 12, color: token.colorTextSecondary, wordBreak: 'break-all' }}>
                  {singleTestResult.error}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Model picker modal */}
      <Modal
        title={t('settings.selectModels', '选择要添加的模型')}
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onOk={handlePickerConfirm}
        okText={`${t('settings.addSelected', '添加选中')} (${pickerSelected.size})`}
        cancelText={t('common.cancel', '取消')}
        okButtonProps={{ disabled: pickerSelected.size === 0 }}
        width={560}
        styles={{ body: { padding: 0 } }}
        afterOpenChange={(open) => { if (open) pickerVirtualizer.measure(); }}
      >
        {(() => {
          const { filtered } = pickerGroups;
          const allFilteredChecked = filtered.length > 0 && filtered.every((m) => pickerSelected.has(m.model_id));
          const someFilteredChecked = filtered.some((m) => pickerSelected.has(m.model_id));
          return (
            <>
              <div style={{ position: 'sticky', top: 0, zIndex: 1, background: 'inherit', padding: '8px 24px', borderBottom: `1px solid ${token.colorBorderSecondary}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Checkbox
                  checked={allFilteredChecked}
                  indeterminate={someFilteredChecked && !allFilteredChecked}
                  onChange={(e) => {
                    setPickerSelected((prev) => {
                      const next = new Set(prev);
                      for (const m of filtered) {
                        if (e.target.checked) next.add(m.model_id);
                        else next.delete(m.model_id);
                      }
                      return next;
                    });
                  }}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {t('common.selectAll', '全选')} ({pickerSelected.size}/{pickerModels.length})
                </Checkbox>
                <Input
                  placeholder={t('settings.searchModels', '搜索模型')}
                  prefix={<Search size={14} />}
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  allowClear
                  size="small"
                  style={{ flex: 1 }}
                />
                <Tooltip title={pickerCollapsed.size === 0 ? t('settings.collapseAll', '收起所有') : t('settings.expandAll', '展开所有')}>
                  <Button
                    size="small"
                    type="text"
                    icon={pickerCollapsed.size === 0 ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    onClick={() => {
                      if (pickerCollapsed.size === 0) {
                        setPickerCollapsed(new Set(pickerGroups.entries.map(([g]) => g)));
                      } else {
                        setPickerCollapsed(new Set());
                      }
                    }}
                  />
                </Tooltip>
              </div>
              <div
                ref={pickerListParentRef}
                className="model-picker-list"
                style={{ maxHeight: 420, overflow: 'auto', padding: '8px 16px 12px' }}
              >
                <div style={{ height: pickerVirtualizer.getTotalSize(), position: 'relative' }}>
                  {pickerVirtualizer.getVirtualItems().map((virtualRow) => {
                    const row = flatPickerRows[virtualRow.index];
                    if (row.type === 'spacer') {
                      return (
                        <div
                          key={virtualRow.key}
                          data-index={virtualRow.index}
                          ref={pickerVirtualizer.measureElement}
                          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 8, transform: `translateY(${virtualRow.start}px)` }}
                        />
                      );
                    }
                    if (row.type === 'group') {
                      const { group, models } = row;
                      const allChecked = models.every((m) => pickerSelected.has(m.model_id));
                      const someChecked = models.some((m) => pickerSelected.has(m.model_id));
                      const collapsed = pickerCollapsed.has(group);
                      return (
                        <div
                          key={`g-${group}`}
                          data-index={virtualRow.index}
                          ref={pickerVirtualizer.measureElement}
                          style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                        >
                          <div
                            className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                            style={{ cursor: 'pointer', userSelect: 'none', background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))' }}
                            onClick={() => setPickerCollapsed((prev) => {
                              const next = new Set(prev);
                              if (next.has(group)) next.delete(group); else next.add(group);
                              return next;
                            })}
                          >
                            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            <div onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={allChecked}
                                indeterminate={someChecked && !allChecked}
                                onChange={(e) => {
                                  setPickerSelected((prev) => {
                                    const next = new Set(prev);
                                    for (const m of models) {
                                      if (e.target.checked) next.add(m.model_id);
                                      else next.delete(m.model_id);
                                    }
                                    return next;
                                  });
                                }}
                              />
                            </div>
                            <ModelIcon model={models[0]?.model_id ?? group} size={20} type="avatar" />
                            <Text style={{ fontWeight: 600 }}>{group}</Text>
                            <Tag style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>{models.length}</Tag>
                          </div>
                        </div>
                      );
                    }
                    // model row
                    const { model: m } = row;
                    return (
                      <div
                        key={`m-${m.model_id}`}
                        data-index={virtualRow.index}
                        ref={pickerVirtualizer.measureElement}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                      >
                        <div
                          className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                          style={{ paddingLeft: 36 }}
                        >
                          <Checkbox
                            checked={pickerSelected.has(m.model_id)}
                            onChange={(e) => {
                              setPickerSelected((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(m.model_id);
                                else next.delete(m.model_id);
                                return next;
                              });
                            }}
                          />
                          <ModelIcon model={m.model_id} size={20} type="avatar" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1 flex-wrap">
                              <span>{m.name || m.model_id}</span>
                              {m.name && m.name !== m.model_id && (
                                <Text type="secondary" style={{ fontSize: 11 }}>({m.model_id})</Text>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}
