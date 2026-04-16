import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Divider,
  Tag,
  Tabs,
  Typography,
  Popconfirm,
  Collapse,
  Empty,
  theme,
  message,
} from 'antd';
import type { MenuProps } from 'antd';
import { Plus, Trash2, RefreshCw, Radio, Terminal, Plug, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMcpStore } from '@/stores';
import { McpServerIcon } from '@/components/shared/McpServerIcon';
import { IconEditor } from '@/components/shared/IconEditor';
import type { McpServer, CreateMcpServerInput, ToolDescriptor } from '@/types';

const BUILTIN_DISPLAY_NAME_KEYS: Record<string, string> = {
  '@aqbot/fetch': 'settings.mcpServers.builtinFetch',
  '@aqbot/search-file': 'settings.mcpServers.builtinSearchFile',
};

// ── Left Sidebar: Server List ─────────────────────────────

function McpServerList({
  servers,
  selectedId,
  onSelect,
  onAdd,
  enablingServerIds,
  onToggle,
}: {
  servers: McpServer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  enablingServerIds: Set<string>;
  onToggle: (id: string, enable: boolean) => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const builtinServers = useMemo(() => servers.filter((s) => s.source === 'builtin'), [servers]);
  const customServers = useMemo(() => servers.filter((s) => s.source !== 'builtin'), [servers]);

  const renderServerItem = (s: McpServer) => {
    const isSelected = selectedId === s.id;
    const isBuiltin = s.source === 'builtin';
    const displayName = isBuiltin ? t(BUILTIN_DISPLAY_NAME_KEYS[s.name] ?? s.name, s.name) : s.name;

    return (
      <div
        key={s.id}
        className="flex items-center cursor-pointer px-3 py-2.5 transition-colors"
        style={{
          borderRadius: token.borderRadius,
          backgroundColor: isSelected ? token.colorPrimaryBg : undefined,
        }}
        onClick={() => onSelect(s.id)}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.backgroundColor = token.colorFillQuaternary;
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.backgroundColor = '';
        }}
      >
        <span style={{ marginRight: 8, flexShrink: 0, display: 'inline-flex' }}>
          <McpServerIcon server={s} size={isBuiltin ? 16 : 24} />
        </span>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <span style={{ color: isSelected ? token.colorPrimary : undefined }}>{displayName}</span>
          {!isBuiltin && (
            <Tag
              color={s.transport === 'stdio' ? 'blue' : s.transport === 'sse' ? 'orange' : 'green'}
              style={{ margin: 0, fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 3 }}
            >
              {s.transport === 'sse' ? <Radio size={11} /> : s.transport === 'http' ? <Globe size={11} /> : <Terminal size={11} />}
              {s.transport.toUpperCase()}
            </Tag>
          )}
        </div>
        <Switch
          size="small"
          checked={s.enabled}
          loading={enablingServerIds.has(s.id)}
          disabled={enablingServerIds.has(s.id)}
          onClick={(_, e) => e.stopPropagation()}
          onChange={() => onToggle(s.id, !s.enabled)}
        />
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {servers.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.mcpServers.empty')} />
          </div>
        ) : (
          <>
            {builtinServers.length > 0 && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 11, padding: '4px 12px', textTransform: 'uppercase' }}>
                  {t('settings.mcpServers.builtin')}
                </Typography.Text>
                {builtinServers.map(renderServerItem)}
              </>
            )}
            {builtinServers.length > 0 && customServers.length > 0 && (
              <Divider style={{ margin: '4px 0' }} />
            )}
            {customServers.length > 0 && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 11, padding: '4px 12px', textTransform: 'uppercase' }}>
                  {t('settings.mcpServers.custom')}
                </Typography.Text>
                {customServers.map(renderServerItem)}
              </>
            )}
          </>
        )}
      </div>
      <div className="shrink-0 p-2 pt-0">
        <Button
          type="dashed"
          block
          icon={<Plus size={14} />}
          onClick={onAdd}
        >
          {t('settings.mcpServers.add')}
        </Button>
      </div>
    </div>
  );
}

// ── Right Panel: Server Detail ────────────────────────────

function McpServerDetail({
  server,
  onDeleted,
  enabling,
  onToggle,
}: {
  server: McpServer;
  onDeleted: () => void;
  enabling: boolean;
  onToggle: (enable: boolean) => void;
}) {
  const { t } = useTranslation();
  const { updateServer, deleteServer, toolDescriptors, loadToolDescriptors, discoverTools } = useMcpStore();
  const [discovering, setDiscovering] = useState(false);

  // Local state for text inputs to avoid cursor-jump on every keystroke
  const [localName, setLocalName] = useState(server.name);
  const [localCommand, setLocalCommand] = useState(server.command ?? '');
  const [localArgs, setLocalArgs] = useState(() => {
    try { return (JSON.parse(server.argsJson ?? '[]') as string[]).join(' '); } catch { return ''; }
  });
  const [localEndpoint, setLocalEndpoint] = useState(server.endpoint ?? '');
  const [localHeaders, setLocalHeaders] = useState(() => {
    try {
      const obj = JSON.parse(server.headersJson ?? '{}') as Record<string, string>;
      return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
    } catch { return ''; }
  });
  const [localEnv, setLocalEnv] = useState(() => {
    try {
      const obj = JSON.parse(server.envJson ?? '{}') as Record<string, string>;
      return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
    } catch { return ''; }
  });

  // Reset local state when switching servers
  useEffect(() => {
    setLocalName(server.name);
    setLocalCommand(server.command ?? '');
    try { setLocalArgs((JSON.parse(server.argsJson ?? '[]') as string[]).join(' ')); } catch { setLocalArgs(''); }
    setLocalEndpoint(server.endpoint ?? '');
    try {
      const obj = JSON.parse(server.headersJson ?? '{}') as Record<string, string>;
      setLocalHeaders(Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n'));
    } catch { setLocalHeaders(''); }
    try {
      const obj = JSON.parse(server.envJson ?? '{}') as Record<string, string>;
      setLocalEnv(Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n'));
    } catch { setLocalEnv(''); }
  }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadToolDescriptors(server.id);
  }, [server.id, loadToolDescriptors]);

  const tools: ToolDescriptor[] = toolDescriptors[server.id] ?? [];
  const rowStyle = { padding: '4px 0' };
  const isBuiltin = server.source === 'builtin';
  const displayName = isBuiltin ? t(BUILTIN_DISPLAY_NAME_KEYS[server.name] ?? server.name, server.name) : server.name;

  const handleFieldChange = async (field: string, value: unknown) => {
    await updateServer(server.id, { [field]: value });
  };

  const handleDiscoverTools = async () => {
    setDiscovering(true);
    try {
      await discoverTools(server.id);
      message.success(t('settings.mcpServers.refreshSuccess'));
    } catch (e) {
      message.error(`${t('settings.mcpServers.refreshFailed')}: ${e}`);
    } finally {
      setDiscovering(false);
    }
  };

  const handleDelete = async () => {
    await deleteServer(server.id);
    onDeleted();
  };

  const resetIconMenuItem: MenuProps['items'] = [
    { type: 'divider' as const },
    { key: 'reset', icon: <Plug size={14} />, label: t('settings.mcpServers.resetIcon'),
      onClick: async () => { await updateServer(server.id, { iconType: '', iconValue: '' }); } },
  ];

  return (
    <div className="p-6 pb-12 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {isBuiltin ? (
            <McpServerIcon server={server} size={36} />
          ) : (
            <IconEditor
              iconType={server.iconType}
              iconValue={server.iconValue}
              onChange={async (type, value) => {
                await updateServer(server.id, { iconType: type ?? '', iconValue: value ?? '' });
              }}
              size={36}
              defaultIcon={<McpServerIcon server={server} size={36} />}
              extraMenuItems={resetIconMenuItem}
            />
          )}
          <span style={{ fontWeight: 600, fontSize: 16 }}>{displayName}</span>
          {isBuiltin && (
            <Tag color="blue" style={{ margin: 0 }}>{t('settings.mcpServers.builtin')}</Tag>
          )}
        </div>
        {!isBuiltin && (
          <Popconfirm
            title={t('settings.mcpServers.deleteConfirm')}
            onConfirm={handleDelete}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
          >
            <Button danger size="small" icon={<Trash2 size={14} />}>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        )}
      </div>


      {!isBuiltin && (
        <>
          <div style={rowStyle} className="flex items-center justify-between">
            <span>{t('settings.mcpServers.name')}</span>
            <Input
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onBlur={() => { if (localName !== server.name) handleFieldChange('name', localName); }}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: '4px 0' }} />
          <div style={rowStyle} className="flex items-center justify-between">
            <span>{t('settings.mcpServers.transport')}</span>
            <Select
              value={server.transport}
              onChange={(val) => handleFieldChange('transport', val)}
              style={{ width: 280 }}
              options={[
                { value: 'sse', label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Radio size={14} /> SSE</span> },
                { value: 'http', label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Globe size={14} /> StreamableHTTP</span> },
                { value: 'stdio', label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Terminal size={14} /> Stdio</span> },
              ]}
            />
          </div>
          <Divider style={{ margin: '4px 0' }} />
        </>
      )}

      {server.transport === 'stdio' && !isBuiltin && (
        <>
          <div style={rowStyle} className="flex items-center justify-between">
            <span>{t('settings.mcpServers.command')}</span>
            <Input
              value={localCommand}
              onChange={(e) => setLocalCommand(e.target.value)}
              onBlur={() => handleFieldChange('command', localCommand || null)}
              placeholder="npx"
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: '4px 0' }} />
          <div style={rowStyle} className="flex items-center justify-between">
            <span>{t('settings.mcpServers.args')}</span>
            <Input
              value={localArgs}
              onChange={(e) => setLocalArgs(e.target.value)}
              onBlur={() => {
                const arr = localArgs ? localArgs.split(/\s+/).filter(Boolean) : [];
                handleFieldChange('args', arr.length > 0 ? arr : null);
              }}
              placeholder="-y @modelcontextprotocol/server-name"
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: '4px 0' }} />
        </>
      )}

      {(server.transport === 'http' || server.transport === 'sse') && !isBuiltin && (
        <>
          <div style={rowStyle} className="flex items-center justify-between">
            <span>{t('settings.mcpServers.endpoint')}</span>
            <Input
              value={localEndpoint}
              onChange={(e) => setLocalEndpoint(e.target.value)}
              onBlur={() => handleFieldChange('endpoint', localEndpoint || null)}
              placeholder="http://localhost:3000"
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: '4px 0' }} />
          <div style={rowStyle} className="flex items-center justify-between">
            <span>{t('settings.mcpServers.customHeaders')}</span>
            <Input.TextArea
              value={localHeaders}
              onChange={(e) => setLocalHeaders(e.target.value)}
              onBlur={() => {
                const lines = localHeaders.split('\n').filter((l) => l.includes('='));
                const obj: Record<string, string> = {};
                for (const line of lines) {
                  const idx = line.indexOf('=');
                  if (idx > 0) obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
                handleFieldChange('headersJson', lines.length > 0 ? JSON.stringify(obj) : null);
              }}
              placeholder={'Authorization=Bearer xxx\nX-Custom=value'}
              autoSize={{ minRows: 2, maxRows: 6 }}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: '4px 0' }} />
        </>
      )}

      {!isBuiltin && (
        <>
          <div style={rowStyle} className="flex items-center justify-between">
            <span>{t('settings.mcpServers.envVars')}</span>
            <Input.TextArea
              value={localEnv}
              onChange={(e) => setLocalEnv(e.target.value)}
              onBlur={() => {
                const lines = localEnv.split('\n').filter((l) => l.includes('='));
                const obj: Record<string, string> = {};
                for (const line of lines) {
                  const idx = line.indexOf('=');
                  if (idx > 0) obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
                handleFieldChange('env', Object.keys(obj).length > 0 ? obj : null);
              }}
              placeholder={t('settings.mcpServers.envVarsPlaceholder')}
              autoSize={{ minRows: 2, maxRows: 6 }}
              style={{ width: 280 }}
            />
          </div>
          <Divider style={{ margin: '4px 0' }} />
        </>
      )}

      {!isBuiltin && (
        <>
          <div style={rowStyle} className="flex items-center justify-between">
            <span>{t('settings.mcpServers.discoverTimeout')}</span>
            <InputNumber
              value={server.discoverTimeoutSecs}
              onChange={(val) => handleFieldChange('discoverTimeoutSecs', val)}
              placeholder="30"
              min={5}
              max={300}
              addonAfter="s"
              style={{ width: 160 }}
            />
          </div>
          <Divider style={{ margin: '4px 0' }} />
        </>
      )}

      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('settings.mcpServers.executeTimeout')}</span>
        <InputNumber
          value={server.executeTimeoutSecs}
          onChange={(val) => handleFieldChange('executeTimeoutSecs', val)}
          placeholder="30"
          min={5}
          max={600}
          addonAfter="s"
          style={{ width: 160 }}
        />
      </div>
      <Divider style={{ margin: '4px 0' }} />

      <div style={rowStyle} className="flex items-center justify-between">
        <span>{t('common.enabled')}</span>
        <Switch
          checked={server.enabled}
          loading={enabling}
          disabled={enabling}
          onChange={(val) => onToggle(val)}
        />
      </div>

      {/* Tool Descriptors */}
      <Divider />
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('settings.mcpServers.tools')}
          {tools.length > 0 && (
            <Tag style={{ marginLeft: 8, fontWeight: 400 }}>{tools.length}</Tag>
          )}
        </Typography.Title>
        {!isBuiltin && (
          <Button
            size="small"
            icon={<RefreshCw size={14} className={discovering ? 'animate-spin' : ''} />}
            loading={discovering}
            disabled={!server.enabled}
            onClick={handleDiscoverTools}
          >
            {t('settings.mcpServers.refreshTools')}
          </Button>
        )}
      </div>
      {tools.length === 0 ? (
        <Empty description={t('settings.mcpServers.noTools')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Collapse
          size="small"
          items={tools.map((tool) => ({
            key: tool.id,
            label: tool.name,
            children: <Typography.Text type="secondary">{tool.description || '—'}</Typography.Text>,
          }))}
        />
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────

export default function McpServerSettings() {
  const { t } = useTranslation();
  const { servers, loadServers, createServer, updateServer, discoverTools } = useMcpStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<'form' | 'import'>('form');
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [form] = Form.useForm();
  const transport = Form.useWatch('transport', form);

  const [enablingServerIds, setEnablingServerIds] = useState<Set<string>>(new Set());

  const handleToggleEnabled = async (serverId: string, enable: boolean) => {
    if (!enable) {
      await updateServer(serverId, { enabled: false });
      return;
    }
    setEnablingServerIds((prev) => new Set(prev).add(serverId));
    try {
      await discoverTools(serverId);
      await updateServer(serverId, { enabled: true });
    } catch (e) {
      message.error(`${t('settings.mcpServers.refreshFailed')}: ${e}`);
    } finally {
      setEnablingServerIds((prev) => {
        const next = new Set(prev);
        next.delete(serverId);
        return next;
      });
    }
  };

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  useEffect(() => {
    if (!selectedId && servers.length > 0) {
      setSelectedId(servers[0].id);
    }
  }, [servers, selectedId]);

  const selectedServer = servers.find((s) => s.id === selectedId) ?? null;

  const handleAdd = () => {
    form.resetFields();
    form.setFieldsValue({ transport: 'stdio' });
    setModalTab('form');
    setImportJson('');
    setImportError(null);
    setModalOpen(true);
  };

  const parseImportJson = (raw: string): CreateMcpServerInput[] => {
    const obj = JSON.parse(raw);
    const serversObj = obj.mcpServers ?? obj;
    const results: CreateMcpServerInput[] = [];
    for (const [name, cfg] of Object.entries(serversObj)) {
      const c = cfg as Record<string, unknown>;
      let transport: 'stdio' | 'http' | 'sse';
      if (c.type === 'streamable_http') transport = 'http';
      else if (c.type === 'sse') transport = 'sse';
      else if (c.command) transport = 'stdio';
      else continue;
      results.push({
        name,
        transport,
        command: typeof c.command === 'string' ? c.command : undefined,
        args: Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : undefined,
        endpoint: typeof c.url === 'string' ? c.url : undefined,
        enabled: false,
      });
    }
    return results;
  };

  const handleImportCreate = async () => {
    let inputs: CreateMcpServerInput[];
    try {
      inputs = parseImportJson(importJson);
    } catch {
      setImportError(t('settings.mcpServers.importParseError'));
      return;
    }
    if (inputs.length === 0) {
      setImportError(t('settings.mcpServers.importEmpty'));
      return;
    }
    for (const input of inputs) {
      await createServer(input);
    }
    message.success(t('settings.mcpServers.importSuccess', { count: inputs.length }));
    setModalOpen(false);
    setImportJson('');
    setImportError(null);
  };

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const input: CreateMcpServerInput = {
        name: values.name,
        transport: values.transport,
        command: values.command,
        args: values.args ? values.args.split(/\s+/).filter(Boolean) : undefined,
        endpoint: values.endpoint,
        enabled: false,
      };
      await createServer(input);
      setModalOpen(false);
      form.resetFields();
    } catch {
      // validation error
    }
  };

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 pt-2" style={{ borderRight: '1px solid var(--border-color)' }}>
        <McpServerList
          servers={servers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={handleAdd}
          enablingServerIds={enablingServerIds}
          onToggle={handleToggleEnabled}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selectedServer ? (
          <McpServerDetail
            key={selectedServer.id}
            server={selectedServer}
            onDeleted={() => setSelectedId(null)}
            enabling={enablingServerIds.has(selectedServer.id)}
            onToggle={(enable) => handleToggleEnabled(selectedServer.id, enable)}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('settings.mcpServers.selectOrAdd')}
            />
          </div>
        )}
      </div>

      <Modal
        title={t('settings.mcpServers.add')}
        open={modalOpen}
        onOk={modalTab === 'form' ? handleCreate : handleImportCreate}
        onCancel={() => { setModalOpen(false); form.resetFields(); setImportJson(''); setImportError(null); }}
        mask={{ enabled: true, blur: true }}
      >
        <Tabs
          activeKey={modalTab}
          onChange={(k) => { setModalTab(k as 'form' | 'import'); setImportError(null); }}
          items={[
            {
              key: 'form',
              label: t('settings.mcpServers.tabForm'),
              children: (
                <Form form={form} layout="vertical" initialValues={{ transport: 'stdio' }}>
                  <Form.Item name="name" label={t('settings.mcpServers.name')} rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="transport" label={t('settings.mcpServers.transport')} rules={[{ required: true }]}>
                    <Select options={[
                      { value: 'sse', label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Radio size={14} /> SSE</span> },
                      { value: 'http', label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Globe size={14} /> StreamableHTTP</span> },
                      { value: 'stdio', label: <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Terminal size={14} /> Stdio</span> },
                    ]} />
                  </Form.Item>
                  {transport === 'stdio' && (
                    <>
                      <Form.Item name="command" label={t('settings.mcpServers.command')}>
                        <Input placeholder="npx" />
                      </Form.Item>
                      <Form.Item name="args" label={t('settings.mcpServers.args')}>
                        <Input placeholder="-y @modelcontextprotocol/server-name" />
                      </Form.Item>
                    </>
                  )}
                  {(transport === 'http' || transport === 'sse') && (
                    <Form.Item name="endpoint" label={t('settings.mcpServers.endpoint')}>
                      <Input placeholder="http://localhost:3000" />
                    </Form.Item>
                  )}
                </Form>
              ),
            },
            {
              key: 'import',
              label: t('settings.mcpServers.tabImport'),
              children: (
                <div>
                  <Input.TextArea
                    rows={10}
                    value={importJson}
                    onChange={(e) => { setImportJson(e.target.value); setImportError(null); }}
                    placeholder={t('settings.mcpServers.importPlaceholder')}
                    status={importError ? 'error' : undefined}
                    style={{ fontFamily: 'monospace' }}
                  />
                  {importError && (
                    <div style={{ color: '#d32029', fontSize: 12, marginTop: 4 }}>{importError}</div>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
}
