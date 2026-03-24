import { useMemo } from 'react';
import { Card, Tag, Typography, Collapse, theme } from 'antd';
import { CheckCircle, XCircle, Loader, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ToolCallCardProps {
  toolName: string;
  serverName: string;
  status: 'running' | 'success' | 'error';
  input?: string;
  output?: string;
  startedAt?: number;
  finishedAt?: number;
}

const statusConfig = {
  running: { icon: <Loader size={14} className="animate-spin" />, color: 'blue' },
  success: { icon: <CheckCircle size={14} />, color: 'green' },
  error: { icon: <XCircle size={14} />, color: 'red' },
} as const;

export function ToolCallCard({
  toolName,
  serverName,
  status,
  input,
  output,
  startedAt,
  finishedAt,
}: ToolCallCardProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const duration = useMemo(() => {
    if (startedAt && finishedAt) {
      const ms = finishedAt - startedAt;
      return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
    }
    return null;
  }, [startedAt, finishedAt]);

  const { icon: statusIcon, color: statusColor } = statusConfig[status];

  const collapseItems = useMemo(() => {
    const items = [];
    if (input) {
      items.push({
        key: 'input',
        label: t('chat.inspector.toolInput', 'Input'),
        children: (
          <pre
            style={{
              margin: 0,
              padding: 8,
              fontSize: 12,
              fontFamily: 'monospace',
              backgroundColor: token.colorBgTextHover,
              borderRadius: token.borderRadius,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: 200,
              overflow: 'auto',
            }}
          >
            {input}
          </pre>
        ),
      });
    }
    if (output) {
      items.push({
        key: 'output',
        label: t('chat.inspector.toolOutput', 'Output'),
        children: (
          <pre
            style={{
              margin: 0,
              padding: 8,
              fontSize: 12,
              fontFamily: 'monospace',
              backgroundColor: token.colorBgTextHover,
              borderRadius: token.borderRadius,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: 200,
              overflow: 'auto',
            }}
          >
            {output}
          </pre>
        ),
      });
    }
    return items;
  }, [input, output, token, t]);

  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Wrench size={14} />
        <Typography.Text>{toolName}</Typography.Text>
        <Tag>{serverName}</Tag>
        <Tag icon={statusIcon} color={statusColor}>
          {status}
        </Tag>
        {duration && (
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
            {duration}
          </Typography.Text>
        )}
      </div>
      {collapseItems.length > 0 && <Collapse size="small" items={collapseItems} />}
    </Card>
  );
}
