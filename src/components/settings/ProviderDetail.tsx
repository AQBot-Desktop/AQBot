import {
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Slider,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  App,
  theme,
} from 'antd';
import { Maximize2, Mic, Lightbulb, Copy, Database, Trash2, Eye, Heart, Key, MessageSquare, Plus, RefreshCw, Search, Settings, Minimize2, Wrench, Undo2 } from 'lucide-react';
import { ProviderIcon, ModelIcon } from '@lobehub/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderStore, useUIStore } from '@/stores';
import { getProviderIconKey } from '@/lib/providerIcons';
import { getEditableCapabilities, getVisibleModelCapabilities, sanitizeModelCapabilities } from '@/lib/modelCapabilities';
import IconPickerModal from './IconPickerModal';
import type { Model, ModelCapability, ModelType, ModelParamOverrides, ProviderType } from '@/types';

const { Text, Title } = Typography;

const CAPABILITY_LABEL_KEYS: Record<ModelCapability, string> = {
  TextChat: '文本对话',
  Vision: '视觉',
  FunctionCalling: '函数调用',
  Reasoning: '推理',
  RealtimeVoice: '实时语音',
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

const MODEL_TYPE_CONFIG: Record<ModelType, { label: string; color: string; icon: React.ReactNode }> = {
  Chat: { label: '对话', color: 'blue', icon: <MessageSquare size={12} /> },
  Voice: { label: '语音', color: 'red', icon: <Mic size={12} /> },
  Embedding: { label: '向量', color: 'cyan', icon: <Database size={12} /> },
};

const DEFAULT_PATHS: Record<ProviderType, string> = {
  openai: '/v1/chat/completions',
  anthropic: '/v1/messages',
  gemini: '/v1beta/models',
  custom: '/v1/chat/completions',
};

const DEFAULT_HOSTS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com',
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
  const [paramForm] = Form.useForm();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconOverrides, setIconOverrides] = useState<Record<string, string>>({});
  const [apiHostLocal, setApiHostLocal] = useState(provider?.api_host ?? '');
  const [apiPathLocal, setApiPathLocal] = useState(provider?.api_path ?? '');
  const apiHostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiPathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state when provider changes (e.g. switching providers)
  useEffect(() => {
    setApiHostLocal(provider?.api_host ?? '');
    setApiPathLocal(provider?.api_path ?? '');
  }, [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
      } catch {
        message.error(t('error.keyValidationFailed'));
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
      await saveModels(providerId, models);
      message.success(t('settings.refreshModelsSuccess'));
    } catch (e) {
      const errMsg = String(e);
      if (errMsg.includes('No active key') || errMsg.includes('key')) {
        message.error(t('settings.noActiveKeyError'));
      } else {
        message.error(t('error.loadFailed'));
      }
    } finally {
      setRefreshing(false);
    }
  }, [providerId, fetchRemoteModels, saveModels, message, t]);

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
      paramForm.setFieldsValue({
        temperature: model.param_overrides?.temperature ?? 0.7,
        max_tokens: model.param_overrides?.max_tokens ?? 4096,
        top_p: model.param_overrides?.top_p ?? 1.0,
        frequency_penalty: model.param_overrides?.frequency_penalty ?? 0.0,
      });
      setSettingsModalOpen(true);
    },
    [paramForm],
  );

  const handleSaveSettings = useCallback(async () => {
    if (!editingModel) return;
    const values = paramForm.getFieldsValue() as ModelParamOverrides;
    const nextCapabilities = sanitizeModelCapabilities(editModelType, editCapabilities);
    try {
      await updateModelParams(providerId, editingModel.model_id, values);
      // Update capabilities locally via saveModels
      const updatedModels = (provider?.models ?? []).map((m) =>
        m.model_id === editingModel.model_id
          ? { ...m, capabilities: nextCapabilities, model_type: editModelType, param_overrides: values }
          : m,
      );
      await saveModels(providerId, updatedModels);
      setSettingsModalOpen(false);
      setEditingModel(null);
    } catch {
      message.error(t('error.saveFailed'));
    }
  }, [editingModel, editCapabilities, editModelType, providerId, paramForm, updateModelParams, saveModels, provider?.models, message, t]);

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
          <ProviderIcon provider={getProviderIconKey(provider)} size={40} type="avatar" shape="square" />
          <div>
            <div className="flex items-center gap-2">
              <Title level={4} className="!mb-0">
                {provider.name}
              </Title>
              <Text type="secondary" className="text-sm">({provider.provider_type})</Text>
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
        <Form layout="horizontal" colon={false} labelCol={{ flex: '80px' }} wrapperCol={{ flex: 1 }}>
          <Form.Item label="Base URL" style={{ marginBottom: 12 }}>
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
          </Form.Item>
          <Form.Item label={t('settings.apiPath')} style={{ marginBottom: 0 }}>
            <Input
              value={apiPathLocal || DEFAULT_PATHS[provider.provider_type]}
              onChange={(e) => handleApiPathChange(e.target.value)}
              placeholder={DEFAULT_PATHS[provider.provider_type]}
            />
          </Form.Item>
        </Form>
      </Card>

      {/* Models List */}
      <Card
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
              <Tooltip title={t('settings.testModels')}>
                <Button
                  type="text"
                size="small"
                icon={<Heart size={14} />}
                onClick={() => message.info(t('common.comingSoon'))}
              />
            </Tooltip>
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
        <div className="flex flex-col gap-2">
          {Object.entries(groupedModels).map(([group, models]) => {
            const allEnabled = models.every((m) => m.enabled);
            const someEnabled = models.some((m) => m.enabled);
            return (
              <Collapse
                key={group}
                activeKey={expandedGroups.includes(group) ? [group] : []}
                onChange={(keys) => {
                  if (keys.length > 0) setExpandedGroups((prev) => [...prev, group]);
                  else setExpandedGroups((prev) => prev.filter((k) => k !== group));
                }}
                items={[{
                  key: group,
                  label: (
                    <div className="flex items-center gap-2">
                      <Text>{group}</Text>
                      <Tag style={{ fontSize: 11, lineHeight: '18px', padding: '0 6px', margin: 0 }}>{models.length}</Tag>
                    </div>
                  ),
                  extra: (
                    <Space size="small" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title={t('settings.addModelToGroup', '添加到当前分组')}>
                        <Button
                          size="small"
                          type="text"
                          icon={<Plus size={14} />}
                          onClick={() => handleOpenAddModel(group)}
                        />
                      </Tooltip>
                      <Switch
                        size="small"
                        checked={someEnabled}
                        style={someEnabled && !allEnabled ? { backgroundColor: token.colorWarning } : undefined}
                        onChange={(checked) => {
                          models.forEach((m) => toggleModel(providerId, m.model_id, checked));
                        }}
                      />
                    </Space>
                  ),
                  children: (
                    <div className="flex flex-col gap-1">
                      {models.map((model) => (
                        <div
                          key={model.model_id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                          style={{
                            opacity: model.enabled ? 1 : 0.45,
                          }}
                        >
                          <ModelIcon
                            model={iconOverrides[model.model_id] ?? model.model_id}
                            size={20}
                            type="avatar"
                          />
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
                                <span style={{ marginLeft: 2 }}>{t(`settings.modelType.${model.model_type || 'Chat'}`, MODEL_TYPE_CONFIG[model.model_type || 'Chat'].label)}</span>
                              </Tag>
                              {getVisibleModelCapabilities(model).map((cap) => (
                                <Tooltip key={cap} title={t(`settings.capability.${cap}`, CAPABILITY_LABEL_KEYS[cap])}>
                                  <Tag
                                    color={CAPABILITY_COLORS[cap]}
                                    bordered={false}
                                    style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}
                                  >
                                    {CAPABILITY_ICONS[cap]}
                                  </Tag>
                                </Tooltip>
                              ))}
                            </div>
                          </div>
                          <div className="flex items-center gap-1" style={{ flexShrink: 0 }}>
                            <Switch
                              size="small"
                              checked={model.enabled}
                              onChange={(checked) =>
                                toggleModel(providerId, model.model_id, checked)
                              }
                            />
                            <Button
                              type="text"
                              size="small"
                              icon={<Settings size={14} />}
                              onClick={() => handleOpenSettings(model)}
                            />
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
                      ))}
                    </div>
                  ),
                }]}
              />
            );
          })}
        </div>
      </Card>

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
                label: t(`settings.modelType.${type_}`, MODEL_TYPE_CONFIG[type_].label),
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
          <div className="space-y-4">
            {/* Model Icon + Name */}
            <div className="flex items-center gap-3 mb-4">
              <div
                className="cursor-pointer rounded-lg p-1 transition-colors hover:bg-gray-100"
                onClick={() => setIconPickerOpen(true)}
                title={t('settings.chooseIcon')}
              >
                <ModelIcon
                  model={iconOverrides[editingModel.model_id] ?? editingModel.model_id}
                  size={32}
                  type="avatar"
                />
              </div>
              <div>
                <div className="font-medium">{editingModel.name || editingModel.model_id}</div>
                <div className="flex items-center gap-1">
                  <Text type="secondary" className="text-sm">{editingModel.model_id}</Text>
                  <Button
                    type="text"
                    size="small"
                    icon={<Copy size={14} />}
                    onClick={() => {
                      navigator.clipboard.writeText(editingModel.model_id);
                      message.success(t('common.copySuccess'));
                    }}
                  />
                </div>
              </div>
            </div>

            <Divider className="my-3" />

            {/* Model Type */}
            <div>
              <div className="font-medium mb-2">{t('settings.modelType.title', '模型类型')}</div>
              <div className="flex gap-2">
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
                    <span style={{ marginLeft: 4 }}>{t(`settings.modelType.${type_}`, MODEL_TYPE_CONFIG[type_].label)}</span>
                  </Tag>
                ))}
              </div>
            </div>

            {editModelType === 'Chat' && (
              <>
                <Divider className="my-3" />

                {/* Capabilities */}
                <div>
                  <div className="font-medium mb-2">{t('settings.modelAbilities')}</div>
                  <Checkbox.Group
                    value={editCapabilities}
                    onChange={(vals) =>
                      setEditCapabilities(sanitizeModelCapabilities(editModelType, vals as ModelCapability[]))
                    }
                  >
                    <div className="grid grid-cols-2 gap-2">
                      {getEditableCapabilities(editModelType).map((cap) => (
                        <Checkbox key={cap} value={cap}>
                          <Tag color={CAPABILITY_COLORS[cap]} bordered={false}>
                            {t(`settings.capability.${cap}`, CAPABILITY_LABEL_KEYS[cap])}
                          </Tag>
                        </Checkbox>
                      ))}
                    </div>
                  </Checkbox.Group>
                </div>
              </>
            )}

            <Divider className="my-3" />

            {/* Parameters */}
            <div>
              <div className="font-medium mb-2">{t('settings.modelParams')}</div>
              <Form form={paramForm} layout="vertical" size="small">
                <Form.Item name="temperature" label={t('settings.temperature')}>
                  <Slider min={0} max={2} step={0.1} />
                </Form.Item>
                <Form.Item name="max_tokens" label={t('settings.maxTokens')}>
                  <Slider min={256} max={32768} step={256} />
                </Form.Item>
                <Form.Item name="top_p" label={t('settings.topP')}>
                  <Slider min={0} max={1} step={0.05} />
                </Form.Item>
                <Form.Item name="frequency_penalty" label={t('settings.frequencyPenalty')}>
                  <Slider min={-2} max={2} step={0.1} />
                </Form.Item>
              </Form>
            </div>
          </div>
        )}
      </Modal>

      {/* Icon Picker Modal */}
      <IconPickerModal
        open={iconPickerOpen}
        onClose={() => setIconPickerOpen(false)}
        onSelect={(iconId) => {
          if (editingModel) {
            setIconOverrides((prev) => ({ ...prev, [editingModel.model_id]: iconId }));
          }
        }}
      />
    </div>
  );
}
