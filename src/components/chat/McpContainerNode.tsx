import React, { useMemo } from 'react';
import { Collapse, Tag } from 'antd';
import { CheckCircle, Loader, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NodeComponentProps } from 'markstream-react';

function safeGetAttr(attrs: any, key: string): string | undefined {
  if (!attrs) return undefined;

  if (Array.isArray(attrs)) {
    for (const item of attrs) {
      if (Array.isArray(item)) {
        const [k, v] = item;
        if (k === key || k === `data-${key}`) {
          if (v == null) return undefined;
          return typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
      } else if (item && typeof item === 'object' && 'name' in item) {
        if (item.name === key || item.name === `data-${key}`) {
          const v = item.value;
          if (v == null) return undefined;
          return typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
      }
    }
    return undefined;
  }

  if (typeof attrs === 'object') {
    for (const k of [key, `data-${key}`]) {
      const v = attrs[k];
      if (v == null) continue;
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }

  return undefined;
}

function extractText(children: any[] | undefined): string {
  if (!children || children.length === 0) return '';
  const parts: string[] = [];
  for (const child of children) {
    if (typeof child === 'string') {
      parts.push(child);
    } else if (child?.content != null) {
      parts.push(typeof child.content === 'object' ? JSON.stringify(child.content) : String(child.content));
    } else if (child?.children) {
      parts.push(extractText(child.children));
    }
  }
  return parts.join('');
}

export function McpContainerNode(props: NodeComponentProps<any>) {
  const { node, ctx, renderNode, indexKey } = props;

  if (node.name !== 'mcp') {
    return (
      <div className={`vmr-container vmr-container-${node.name ?? 'unknown'}`}>
        {Array.isArray(node.children) && ctx && renderNode
          ? node.children.map((child: any, i: number) => (
              <React.Fragment key={`${String(indexKey ?? 'vmr-container')}-${i}`}>
                {renderNode(child, `${String(indexKey ?? 'vmr-container')}-${i}`, ctx)}
              </React.Fragment>
            ))
          : null}
      </div>
    );
  }

  return <McpToolCard node={node} />;
}

const monoStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  maxHeight: 300,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  padding: '4px 0',
};

function McpToolCard({ node }: { node: any }) {
  const { t } = useTranslation();

  const serverName = safeGetAttr(node.attrs, 'name') ?? 'MCP';
  const toolName = safeGetAttr(node.attrs, 'tool') ?? 'unknown';
  const rawArgs = safeGetAttr(node.attrs, 'arguments');
  const isLoading = Boolean(node.loading);

  const resultText = useMemo(() => {
    if (isLoading) return '';
    return extractText(node.children);
  }, [isLoading, node.children]);

  const isError = useMemo(() => {
    if (isLoading) return false;
    const trimmed = resultText.trim();
    return (
      trimmed.startsWith('Error:') ||
      trimmed.startsWith('Error executing tool:') ||
      trimmed.startsWith('错误')
    );
  }, [isLoading, resultText]);

  const status = isLoading ? 'running' : isError ? 'error' : 'success';

  const statusIcon = useMemo(() => {
    if (status === 'running') return <Loader size={12} className="animate-spin" />;
    if (status === 'error') return <XCircle size={12} />;
    return <CheckCircle size={12} />;
  }, [status]);

  const statusColor = status === 'running' ? 'processing' : status === 'error' ? 'error' : 'success';
  const statusLabel = status === 'running'
    ? t('chat.tool.running', '执行中')
    : status === 'error'
      ? t('chat.tool.error', '失败')
      : t('chat.tool.success', '成功');

  const decodedArgs = useMemo(() => {
    if (!rawArgs) return null;
    try {
      const decoded = rawArgs.includes('%') ? decodeURIComponent(rawArgs) : rawArgs;
      return JSON.stringify(JSON.parse(decoded), null, 2);
    } catch {
      return rawArgs;
    }
  }, [rawArgs]);

  const headerLabel = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Tag icon={statusIcon} color={statusColor} style={{ margin: 0 }}>{statusLabel}</Tag>
      <Tag style={{ margin: 0 }}>{serverName}</Tag>
      <span style={{ fontSize: 13 }}>{toolName}</span>
    </span>
  );

  const hasContent = Boolean(decodedArgs) || Boolean(!isLoading && resultText);

  return (
    <span style={{ display: 'block', margin: '8px 0' }}>
      <Collapse
        size="small"
        activeKey={isLoading ? ['1'] : undefined}
        defaultActiveKey={isLoading ? ['1'] : undefined}
        items={hasContent ? [{
          key: '1',
          label: headerLabel,
          children: (
            <>
              {decodedArgs && (
                <div style={{ marginBottom: resultText ? 8 : 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)', marginBottom: 4 }}>
                    {t('chat.tool.input', '输入参数')}
                  </div>
                  <span style={{ ...monoStyle, maxHeight: 200 }}>{decodedArgs}</span>
                </div>
              )}
              {!isLoading && resultText && (
                <div>
                  <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)', marginBottom: 4 }}>
                    {t('chat.tool.output', '执行结果')}
                  </div>
                  <span style={monoStyle}>{resultText}</span>
                </div>
              )}
            </>
          ),
        }] : [{
          key: '1',
          label: headerLabel,
          children: null,
        }]}
      />
    </span>
  );
}
