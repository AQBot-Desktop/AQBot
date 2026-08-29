import React, { useState } from 'react';
import { Button, Card, Space, Tag, Typography, theme } from 'antd';
import { Shield, ShieldCheck, ShieldX, ChevronDown, ChevronRight } from 'lucide-react';
import { useAgentStore } from '@/stores';
import { useTranslation } from 'react-i18next';
import type { AgentRiskLevel } from '@/types/agent';

const { Text } = Typography;

export interface PermissionOptionButton {
  /** Decision / option id sent to onApprove */
  id: string;
  label: string;
  /** primary | default | danger */
  variant?: 'primary' | 'default' | 'danger';
}

interface PermissionCardProps {
  conversationId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  workingDirectory?: string;
  riskLevel?: AgentRiskLevel;
  /**
   * Optional override for approve action (e.g. ACP workbench).
   * When omitted, uses the chat agentStore `agent_approve` path.
   */
  onApprove?: (decision: string) => Promise<void>;
  /**
   * Optional custom option buttons. Defaults are derived from riskLevel
   * only when this prop is omitted.
   */
  options?: PermissionOptionButton[];
}

function commandFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function timeoutFromInput(input: Record<string, unknown>): string | undefined {
  const value = input.timeout ?? input.timeout_ms ?? input.timeoutSecs;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

function defaultPermissionOptions(
  riskLevel: AgentRiskLevel | undefined,
  t: (key: string) => string,
): PermissionOptionButton[] {
  const allowOnce: PermissionOptionButton = {
    id: 'allow_once',
    label: t('common.allowOnce'),
    variant: 'primary',
  };
  const deny: PermissionOptionButton = {
    id: 'deny',
    label: t('common.deny'),
    variant: 'danger',
  };
  if (riskLevel === 'execute') return [allowOnce, deny];
  return [
    allowOnce,
    { id: 'allow_always', label: t('common.allowAlways'), variant: 'default' },
    deny,
  ];
}

function riskLabel(riskLevel: AgentRiskLevel | undefined, t: (key: string) => string): string | undefined {
  if (riskLevel === 'execute') return t('common.riskExecute');
  if (riskLevel === 'write') return t('common.riskWrite');
  if (riskLevel === 'read_only') return t('common.riskReadOnly');
  return undefined;
}

const PermissionCard: React.FC<PermissionCardProps> = ({
  conversationId,
  toolUseId,
  toolName,
  input,
  status,
  workingDirectory,
  riskLevel,
  onApprove,
  options,
}) => {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);
  const approveToolUse = useAgentStore((state) => state.approveToolUse);
  const [loading, setLoading] = useState<string | null>(null);

  const handleApprove = async (decision: string) => {
    setLoading(decision);
    try {
      if (onApprove) {
        await onApprove(decision);
      } else {
        await approveToolUse(conversationId, toolUseId, decision);
      }
    } catch (e) {
      console.error('[PermissionCard] handleApprove failed:', e);
    } finally {
      setLoading(null);
    }
  };

  const actionOptions: PermissionOptionButton[] = options ?? defaultPermissionOptions(riskLevel, t);
  const command = commandFromInput(input);
  const timeout = timeoutFromInput(input);
  const riskText = riskLabel(riskLevel, t);
  const inputStr = JSON.stringify(input, null, 2);

  const borderColor =
    status === 'pending'
      ? token.colorWarningBorder
      : status === 'approved'
        ? token.colorSuccessBorder
        : status === 'denied'
          ? token.colorErrorBorder
          : token.colorBorderSecondary;

  return (
    <Card
      size="small"
      style={{
        margin: '8px 0',
        borderColor,
        borderRadius: 8,
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        {/* Header */}
        <Space align="center">
          <Shield size={16} />
          <Text strong>{t('common.permissionRequired')}</Text>
          <Tag>{toolName}</Tag>
          {riskText && <Tag color={riskLevel === 'execute' ? 'error' : riskLevel === 'write' ? 'warning' : 'default'}>{riskText}</Tag>}
        </Space>

        {command && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('common.command')}</Text>
            <pre
              style={{
                margin: '4px 0 0',
                padding: 8,
                fontSize: 12,
                fontFamily: 'monospace',
                backgroundColor: token.colorBgTextHover,
                borderRadius: token.borderRadius,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {command}
            </pre>
          </div>
        )}

        {workingDirectory && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('common.workingDirectory')}</Text>
            <div style={{ fontSize: 12, fontFamily: 'monospace' }}>{workingDirectory}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>{t('agent.cwdIsProcessStart')}</Text>
          </div>
        )}

        {timeout && (
          <Space size={8}>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('common.timeout')}</Text>
            <Text style={{ fontSize: 12 }}>{timeout}</Text>
          </Space>
        )}

        {/* Raw JSON details */}
        <div
          onClick={() => setExpanded(!expanded)}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('common.toolInput')}
          </Text>
        </div>
        {expanded && (
          <pre
            style={{
              margin: 0,
              padding: 8,
              fontSize: 11,
              fontFamily: 'monospace',
              backgroundColor: token.colorBgTextHover,
              borderRadius: token.borderRadius,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: 200,
              overflow: 'auto',
            }}
          >
            {inputStr}
          </pre>
        )}

        {/* Action buttons or result */}
        {status === 'pending' ? (
          <Space wrap>
            {actionOptions.map((opt) => (
              <Button
                key={opt.id}
                size="small"
                type={opt.variant === 'primary' ? 'primary' : 'default'}
                danger={opt.variant === 'danger'}
                icon={
                  opt.variant === 'danger'
                    ? <ShieldX size={14} />
                    : <ShieldCheck size={14} />
                }
                loading={loading === opt.id}
                onClick={() => handleApprove(opt.id)}
              >
                {opt.label}
              </Button>
            ))}
          </Space>
        ) : status === 'approved' ? (
          <Space>
            <ShieldCheck size={14} style={{ color: token.colorSuccess }} />
            <Text type="success">{t('common.approved')}</Text>
          </Space>
        ) : status === 'denied' ? (
          <Space>
            <ShieldX size={14} style={{ color: token.colorError }} />
            <Text type="danger">{t('common.denied')}</Text>
          </Space>
        ) : (
          <Space>
            <Text type="warning">⚠️ {t('common.expired')}</Text>
          </Space>
        )}
      </Space>
    </Card>
  );
};

export default PermissionCard;
