import { useEffect, useState } from 'react';
import {
  Button,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  InputNumber,
  Divider,
  Popconfirm,
  App,
  Tag,
  Empty,
  theme,
} from 'antd';
import { Plus, Trash2 } from 'lucide-react';
import { ProviderIcon } from '@lobehub/icons';
import Tavily from '@lobehub/icons/es/Tavily';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { useSearchStore } from '@/stores';
import { SearchProviderTypeIcon, PROVIDER_TYPE_LABELS } from '@/components/shared/SearchProviderIcon';
import type { SearchProvider, CreateSearchProviderInput, SearchProviderType } from '@/types';

function providerSelectOptions(t: (key: string, fallback?: string) => string) {
  return [
    { value: 'tavily', label: <span className="flex items-center gap-2"><Tavily.Color size={16} /> Tavily</span> },
    { value: 'zhipu', label: <span className="flex items-center gap-2"><ProviderIcon provider="zhipu" size={16} type="color" /> {t('settings.searchProviders.zhipu', '智谱')}</span> },
    { value: 'bocha', label: <span className="flex items-center gap-2"><img src="/icons/bocha.ico" alt="" style={{ width: 16, height: 16 }} /> {t('settings.searchProviders.bocha', '博查')}</span> },
  ];
}

const PROVIDER_LABEL_MAP: Record<string, string> = PROVIDER_TYPE_LABELS;

const DEFAULT_ENDPOINTS: Record<string, string> = {
  tavily: 'https://api.tavily.com/search',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/web_search',
  bocha: 'https://api.bochaai.com/v1/web-search',
};

// ── Left Sidebar: Provider List ───────────────────────────

function SearchProviderList({
  providers,
  selectedId,
  onSelect,
  onAdd,
}: {
  providers: SearchProvider[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {providers.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.searchProviders.empty', '暂无搜索供应商')} />
          </div>
        ) : (
          providers.map((p) => {
            const isSelected = selectedId === p.id;
            return (
              <div
                key={p.id}
                className="flex items-center cursor-pointer px-3 py-2.5 transition-colors"
                style={{
                  borderRadius: token.borderRadius,
                  backgroundColor: isSelected ? token.colorPrimaryBg : undefined,
                }}
                onClick={() => onSelect(p.id)}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = token.colorFillQuaternary;
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = '';
                }}
              >
                <div style={{ marginRight: 8, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                  <SearchProviderTypeIcon type={p.providerType} size={20} />
                </div>
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <span className="truncate" style={{ color: isSelected ? token.colorPrimary : undefined }}>{p.name}</span>
                  <Tag style={{ margin: 0, fontSize: 11 }}>{PROVIDER_LABEL_MAP[p.providerType] || p.providerType}</Tag>
                </div>
                <Switch
                  size="small"
                  checked={p.enabled}
                  onClick={(_, e) => e.stopPropagation()}
                  onChange={() => useSearchStore.getState().updateProvider(p.id, { enabled: !p.enabled })}
                />
              </div>
            );
          })
        )}
      </div>
      <div className="shrink-0 p-2 pt-0">
        <Button
          type="dashed"
          block
          icon={<Plus size={14} />}
          onClick={onAdd}
        >
          {t('settings.searchProviders.add')}
        </Button>
      </div>
    </div>
  );
}

// ── Right Panel: Provider Detail ──────────────────────────

function SearchProviderDetail({
  provider,
  onDeleted,
}: {
  provider: SearchProvider;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { updateProvider, deleteProvider } = useSearchStore();
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [testing, setTesting] = useState(false);

  // Reset apiKey input when switching providers
  useEffect(() => {
    setApiKeyInput('');
  }, [provider.id]);

  const rowStyle = { padding: '4px 0' };

  const handleFieldChange = async (field: string, value: unknown) => {
    if (field === 'providerType') {
      const defaultEndpoint = DEFAULT_ENDPOINTS[value as string] ?? '';
      await updateProvider(provider.id, { providerType: value as SearchProviderType, endpoint: defaultEndpoint });
    } else {
      await updateProvider(provider.id, { [field]: value });
    }
  };

  const handleApiKeyBlur = async () => {
    if (apiKeyInput.trim()) {
      await updateProvider(provider.id, { apiKey: apiKeyInput.trim() });
      setApiKeyInput('');
      message.success(t('common.saveSuccess'));
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const result = await invoke<{ ok: boolean; latencyMs?: number; resultCount?: number; error?: string }>('test_search_provider', { id: provider.id });
      if (result.ok) {
        message.success(`${t('settings.searchProviders.testSuccess', '连接成功')} (${result.latencyMs}ms, ${result.resultCount} ${t('settings.searchProviders.results', '条结果')})`);
      } else {
        message.error(result.error || t('settings.searchProviders.testFailed', '连接失败'));
      }
    } catch (err: any) {
      message.error(err?.toString() || t('settings.searchProviders.testFailed', '连接失败'));
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    await deleteProvider(provider.id);
    onDeleted();
  };


  return (
    <div className="p-6 pb-12 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-4">
        <span style={{ fontWeight: 600, fontSize: 16 }}>{provider.name}</span>
        <div className="flex items-center gap-2">
          <Button
            size="small"
            loading={testing}
            onClick={handleTestConnection}
          >
            {t('settings.searchProviders.testConnection', '测试连接')}
          </Button>
          <Popconfirm
            title={t('settings.searchProviders.deleteConfirm')}
            onConfirm={handleDelete}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
          >
            <Button danger size="small" icon={<Trash2 size={14} />}>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        </div>
      </div>

      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('settings.searchProviders.name')}</span>
        <Input
          value={provider.name}
          onChange={(e) => handleFieldChange('name', e.target.value)}
          style={{ width: 280 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('settings.searchProviders.type')}</span>
        <Select
          value={provider.providerType}
          onChange={(val) => handleFieldChange('providerType', val)}
          style={{ width: 280 }}
          options={providerSelectOptions((key, fallback) => (fallback ? t(key, fallback) : t(key)))}
          disabled
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('settings.searchProviders.endpoint')}</span>
        <Input
          value={provider.endpoint ?? ''}
          onChange={(e) => handleFieldChange('endpoint', e.target.value || null)}
          placeholder={DEFAULT_ENDPOINTS[provider.providerType] ?? 'https://...'}
          style={{ width: 280 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <div style={rowStyle} className="flex items-center justify-between">
        <span>API Key</span>
        <Input.Password
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          onBlur={handleApiKeyBlur}
          placeholder={provider.hasApiKey ? t('settings.searchProviders.apiKeySet', '已设置，留空保持不变') : t('settings.searchProviders.apiKeyPlaceholder', '请输入 API Key')}
          style={{ width: 280 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('settings.searchProviders.resultLimit')}</span>
        <InputNumber
          value={provider.resultLimit ?? 10}
          onChange={(val) => handleFieldChange('resultLimit', val)}
          min={1}
          max={50}
          style={{ width: 150 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('settings.searchProviders.timeout')}</span>
        <InputNumber
          value={provider.timeoutMs ?? 5000}
          onChange={(val) => handleFieldChange('timeoutMs', val)}
          min={1000}
          max={30000}
          step={1000}
          style={{ width: 150 }}
          addonAfter="ms"
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />
      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('common.enabled')}</span>
        <Switch
          checked={provider.enabled}
          onChange={(val) => handleFieldChange('enabled', val)}
        />
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────

export default function SearchProviderSettings() {
  const { t } = useTranslation();
  const { providers, loadProviders, createProvider } = useSearchStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // Auto-select first provider
  useEffect(() => {
    if (!selectedId && providers.length > 0) {
      setSelectedId(providers[0].id);
    }
  }, [providers, selectedId]);

  const selectedProvider = providers.find((p) => p.id === selectedId) ?? null;

  const handleAdd = async () => {
    form.resetFields();
    setModalOpen(true);
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const input: CreateSearchProviderInput = {
        name: values.name,
        providerType: values.provider_type,
        endpoint: DEFAULT_ENDPOINTS[values.provider_type] ?? undefined,
        apiKey: values.api_key,
        resultLimit: values.result_limit ?? 10,
        timeoutMs: values.timeout_ms ?? 5000,
      };
      await createProvider(input);
      setModalOpen(false);
      form.resetFields();
    } catch {
      // validation error
    }
  };

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 pt-2" style={{ borderRight: '1px solid var(--border-color)' }}>
        <SearchProviderList
          providers={providers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={handleAdd}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selectedProvider ? (
          <SearchProviderDetail
            key={selectedProvider.id}
            provider={selectedProvider}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('settings.searchProviders.selectOrAdd', '请选择或添加搜索供应商')}
            />
          </div>
        )}
      </div>

      <Modal
        title={t('settings.searchProviders.add')}
        open={modalOpen}
        onOk={handleCreate}
        onCancel={() => { setModalOpen(false); form.resetFields(); }}
        mask={{ enabled: true, blur: true }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label={t('settings.searchProviders.name')}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="provider_type"
            label={t('settings.searchProviders.type')}
            rules={[{ required: true }]}
          >
            <Select
              options={providerSelectOptions((key, fallback) => (fallback ? t(key, fallback) : t(key)))}
            />
          </Form.Item>
          <Form.Item
            name="api_key"
            label="API Key"
            rules={[{ required: true, message: t('settings.searchProviders.apiKeyPlaceholder', '请输入 API Key') }]}
          >
            <Input.Password placeholder={t('settings.searchProviders.apiKeyPlaceholder', '请输入 API Key')} />
          </Form.Item>
          <Form.Item name="result_limit" label={t('settings.searchProviders.resultLimit')} initialValue={10}>
            <InputNumber min={1} max={50} />
          </Form.Item>
          <Form.Item name="timeout_ms" label={t('settings.searchProviders.timeout')} initialValue={5000}>
            <InputNumber min={1000} max={30000} step={1000} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
