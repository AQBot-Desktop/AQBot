import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Button, Typography, App, Tag, Select } from 'antd';
import { Zap, ZapOff, RefreshCw, AlertCircle } from 'lucide-react';
import { ClaudeCode } from '@lobehub/icons';
import { Codex } from '@lobehub/icons';
import { OpenCode } from '@lobehub/icons';
import { Gemini } from '@lobehub/icons';
import { Cursor } from '@lobehub/icons';
import { useGatewayStore } from '@/stores/gatewayStore';
import type { CliToolInfo, QuickConnectProtocol } from '@/types';

const { Title, Paragraph, Text } = Typography;

interface QuickConnectItem {
  key: string;
  name: string;
  avatar: (size: number) => ReactNode;
  description: string;
}

const CONNECT_ITEMS: QuickConnectItem[] = [
  {
    key: 'claude_code',
    name: 'Claude Code',
    avatar: (size) => <ClaudeCode.Avatar size={size} />,
    description: 'Anthropic 官方 CLI 编程助手，在终端中直接与 Claude 协作编码',
  },
  {
    key: 'codex',
    name: 'Codex',
    avatar: (size) => <Codex.Avatar size={size} />,
    description: 'OpenAI 轻量级编程代理，支持在沙盒中自主完成编码任务',
  },
  {
    key: 'opencode',
    name: 'OpenCode',
    avatar: (size) => <OpenCode.Avatar size={size} />,
    description: '开源终端 AI 编程助手，支持多模型后端的灵活代码工具',
  },
  {
    key: 'gemini',
    name: 'Gemini CLI',
    avatar: (size) => <Gemini.Avatar size={size} />,
    description: 'Google Gemini CLI 编程代理，直接在终端中使用 Gemini 模型',
  },
  {
    key: 'cursor',
    name: 'Cursor',
    avatar: (size) => <Cursor.Avatar size={size} />,
    description: '基于 VS Code 的 AI 原生编辑器，深度集成代码补全与对话',
  },
];

/** Tab icon that cycles through integration target avatars */
export function QuickConnectCycleIcon({ size = 16 }: { size?: number }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % CONNECT_ITEMS.length);
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: size,
      height: size,
      verticalAlign: '-0.125em',
      overflow: 'hidden',
    }}>
      {CONNECT_ITEMS[index].avatar(size)}
    </span>
  );
}

function StatusTag({
  status,
  connectedProtocol,
}: {
  status: string;
  connectedProtocol?: QuickConnectProtocol | null;
}) {
  const { t } = useTranslation();
  const displayStatus = status === 'connected' && connectedProtocol == null ? 'not_connected' : status;
  switch (displayStatus) {
    case 'connected':
      return (
        <Tag color="success">
          {connectedProtocol === 'https'
            ? t('gateway.cliConnectedHttps')
            : connectedProtocol === 'http'
              ? t('gateway.cliConnectedHttp')
              : t('gateway.cliNotConnected')}
        </Tag>
      );
    case 'not_connected':
      return <Tag color="default">{t('gateway.cliNotConnected')}</Tag>;
    case 'not_installed':
      return <Tag color="error">{t('gateway.cliNotInstalled')}</Tag>;
    default:
      return null;
  }
}

function ToolCard({
  item,
  toolInfo,
  selectedKeyId,
  selectedProtocol,
  quickConnectBlocked,
  onConnect,
  onDisconnect,
  connecting,
}: {
  item: QuickConnectItem;
  toolInfo?: CliToolInfo;
  selectedKeyId?: string;
  selectedProtocol?: QuickConnectProtocol;
  quickConnectBlocked: boolean;
  onConnect: (toolId: string) => void;
  onDisconnect: (toolId: string, restoreBackup: boolean) => void;
  connecting: string | null;
}) {
  const { t } = useTranslation();
  const { modal } = App.useApp();

  const status = toolInfo?.status ?? 'not_installed';
  const connectedProtocol = toolInfo?.connectedProtocol ?? null;
  const displayStatus = status === 'connected' && connectedProtocol == null ? 'not_connected' : status;
  const isConnecting = connecting === item.key;
  const isNotInstalled = displayStatus === 'not_installed';
  const isConnected = displayStatus === 'connected';
  const needsReconnect =
    isConnected &&
    connectedProtocol != null &&
    selectedProtocol != null &&
    connectedProtocol !== selectedProtocol;

  const handleConnect = useCallback(() => {
    if (isNotInstalled) {
      modal.confirm({
        title: t('gateway.cliNotInstalledConfirmTitle'),
        content: t('gateway.cliNotInstalledConfirmContent'),
        okText: t('gateway.cliNotInstalledConfirmOk'),
        cancelText: t('gateway.cliNotInstalledConfirmCancel'),
        onOk: () => onConnect(item.key),
      });
    } else {
      onConnect(item.key);
    }
  }, [item.key, isNotInstalled, onConnect, modal, t]);

  const handleDisconnect = useCallback(() => {
    const hasBackup = toolInfo?.hasBackup ?? false;
    if (hasBackup) {
      modal.confirm({
        title: t('gateway.cliDisconnectTitle'),
        content: t('gateway.cliDisconnectContent'),
        okText: t('gateway.cliRestoreBackup'),
        cancelText: t('gateway.cliRemoveFieldsOnly'),
        onOk: () => onDisconnect(item.key, true),
        onCancel: () => onDisconnect(item.key, false),
      });
    } else {
      onDisconnect(item.key, false);
    }
  }, [item.key, toolInfo, onDisconnect, modal, t]);

  return (
    <Card key={item.key} size="small" hoverable className="gateway-quick-connect-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flexShrink: 0 }}>
          {item.avatar(40)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Title level={5} style={{ margin: 0 }}>{item.name}</Title>
            {toolInfo?.version && !isNotInstalled && (
              <Text type="secondary" style={{ fontSize: 12 }}>v{toolInfo.version.replace(/^[^\d]*/, '')}</Text>
            )}
            <StatusTag status={status} connectedProtocol={connectedProtocol} />
          </div>
          <Paragraph
            type="secondary"
            style={{ fontSize: 13, margin: 0, marginTop: 4 }}
            ellipsis={{ rows: 1 }}
          >
            {item.description}
          </Paragraph>
          {toolInfo?.configPath && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {toolInfo.configPath}
            </Text>
          )}
        </div>
        <div style={{ flexShrink: 0 }}>
          {isConnected && !needsReconnect ? (
            <Button
              danger
              icon={<ZapOff size={14} />}
              onClick={handleDisconnect}
              loading={isConnecting}
            >
              {t('gateway.cliDisconnect')}
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<Zap size={14} />}
              onClick={handleConnect}
              disabled={quickConnectBlocked || !selectedKeyId || !selectedProtocol}
              loading={isConnecting}
            >
              {needsReconnect ? t('gateway.cliSwitchProtocolReconnect') : t('gateway.quickConnect')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export function GatewayTemplates() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const {
    status,
    cliTools,
    cliToolsLoading,
    keys,
    fetchStatus,
    fetchCliToolStatuses,
    connectCliTool,
    disconnectCliTool,
    fetchKeys,
  } = useGatewayStore();
  const [connecting, setConnecting] = useState<string | null>(null);
  const enabledKeys = keys.filter((k) => k.enabled && k.has_encrypted_key);
  const quickConnectBlocked = !status.is_running;
  const [selectedKeyId, setSelectedKeyId] = useState<string | undefined>(undefined);
  const availableProtocols = useMemo<QuickConnectProtocol[]>(() => {
    const protocols: QuickConnectProtocol[] = [];

    if (!status.force_ssl) {
      protocols.push('http');
    }
    if (status.https_port != null) {
      protocols.push('https');
    }

    if (protocols.length > 0) {
      return protocols;
    }

    return status.force_ssl ? ['https'] : ['http'];
  }, [status.force_ssl, status.https_port]);
  const [selectedProtocol, setSelectedProtocol] = useState<QuickConnectProtocol | undefined>(undefined);

  useEffect(() => {
    fetchStatus();
    fetchCliToolStatuses();
    fetchKeys();
  }, [fetchStatus, fetchCliToolStatuses, fetchKeys]);

  // Auto-select first key when keys load
  useEffect(() => {
    if (!selectedKeyId && enabledKeys.length > 0) {
      setSelectedKeyId(enabledKeys[0].id);
    }
  }, [enabledKeys, selectedKeyId]);

  useEffect(() => {
    if (!selectedProtocol || !availableProtocols.includes(selectedProtocol)) {
      setSelectedProtocol(availableProtocols[0]);
      return;
    }

    if (availableProtocols.length === 1 && selectedProtocol !== availableProtocols[0]) {
      setSelectedProtocol(availableProtocols[0]);
    }
  }, [availableProtocols, selectedProtocol]);

  const handleRefresh = useCallback(() => {
    void fetchStatus();
    void fetchCliToolStatuses();
  }, [fetchStatus, fetchCliToolStatuses]);

  const handleConnect = useCallback(
    async (toolId: string) => {
      if (!selectedKeyId || !selectedProtocol) return;
      setConnecting(toolId);
      try {
        await connectCliTool(toolId, selectedKeyId, selectedProtocol);
        const name = CONNECT_ITEMS.find((i) => i.key === toolId)?.name;
        message.success(t('gateway.cliConnectSuccess', { name }));
      } catch (e) {
        message.error(t('gateway.cliConnectError', { error: String(e) }));
      } finally {
        setConnecting(null);
      }
    },
    [connectCliTool, message, selectedKeyId, selectedProtocol, t],
  );

  const handleDisconnect = useCallback(
    async (toolId: string, restoreBackup: boolean) => {
      setConnecting(toolId);
      try {
        await disconnectCliTool(toolId, restoreBackup);
        const name = CONNECT_ITEMS.find((i) => i.key === toolId)?.name;
        message.success(t('gateway.cliDisconnectSuccess', { name }));
      } catch (e) {
        message.error(t('gateway.cliDisconnectError', { error: String(e) }));
      } finally {
        setConnecting(null);
      }
    },
    [disconnectCliTool, message, t],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <Button
          icon={<RefreshCw size={14} />}
          onClick={handleRefresh}
          loading={cliToolsLoading}
        >
          {t('gateway.cliRefresh')}
        </Button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Select
            style={{ width: 200 }}
            value={selectedKeyId}
            onChange={setSelectedKeyId}
            placeholder={t('gateway.cliSelectKey')}
            options={enabledKeys.map((k) => ({
              value: k.id,
              label: `${k.name} (${k.key_prefix})`,
            }))}
          />
          <Select<QuickConnectProtocol>
            data-testid="gateway-protocol-select"
            style={{ width: 140 }}
            value={selectedProtocol}
            onChange={setSelectedProtocol}
            placeholder={t('gateway.cliSelectProtocol')}
            disabled={availableProtocols.length <= 1}
            options={availableProtocols.map((protocol) => ({
              value: protocol,
              label: protocol === 'https' ? t('gateway.cliProtocolHttps') : t('gateway.cliProtocolHttp'),
            }))}
          />
        </div>
      </div>
      {quickConnectBlocked && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--ant-color-warning-bg)', borderRadius: 6, marginBottom: 4 }}>
          <AlertCircle size={16} style={{ color: 'var(--ant-color-warning)' }} />
          <Text type="secondary" style={{ fontSize: 13 }}>
            {t('gateway.cliStartGatewayFirst')}
          </Text>
        </div>
      )}
      {enabledKeys.length === 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--ant-color-warning-bg)', borderRadius: 6, marginBottom: 4 }}>
          <AlertCircle size={16} style={{ color: 'var(--ant-color-warning)' }} />
          <Text type="secondary" style={{ fontSize: 13 }}>
            {t('gateway.cliNoKeys')}
          </Text>
        </div>
      )}
      {CONNECT_ITEMS.map((item) => (
        <ToolCard
          key={item.key}
          item={item}
          toolInfo={cliTools.find((t) => t.id === item.key)}
          selectedKeyId={selectedKeyId}
          selectedProtocol={selectedProtocol}
          quickConnectBlocked={quickConnectBlocked}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          connecting={connecting}
        />
      ))}
    </div>
  );
}
