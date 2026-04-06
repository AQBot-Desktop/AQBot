import { useMemo } from 'react';
import { theme, Typography } from 'antd';
import { ThoughtChain, type ThoughtChainItemType } from '@ant-design/x';
import { Terminal, FileEdit, Search, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ToolCallItem {
  toolUseId: string;
  toolName: string;
  status: 'queued' | 'running' | 'success' | 'error' | 'cancelled';
  input?: string;
  output?: string;
  isError?: boolean;
}

interface ToolCallChainProps {
  toolCalls: ToolCallItem[];
}

const statusMap: Record<string, ThoughtChainItemType['status']> = {
  queued: 'loading',
  running: 'loading',
  success: 'success',
  error: 'error',
  cancelled: 'abort',
};

const toolIcons: Record<string, React.ReactNode> = {
  bash: <Terminal size={14} />,
  write: <FileEdit size={14} />,
  read: <Search size={14} />,
  edit: <FileEdit size={14} />,
  glob: <Search size={14} />,
  grep: <Search size={14} />,
  ls: <Search size={14} />,
};

function getToolIcon(toolName: string): React.ReactNode {
  const lower = toolName.toLowerCase();
  for (const [key, icon] of Object.entries(toolIcons)) {
    if (lower.includes(key)) return icon;
  }
  return <Wrench size={14} />;
}

function getInputSummary(input?: string): string | undefined {
  if (!input) return undefined;
  try {
    const parsed = JSON.parse(input);
    if (parsed.command) return parsed.command;
    if (parsed.path) return parsed.path;
    if (parsed.file_path) return parsed.file_path;
    if (parsed.pattern) return parsed.pattern;
    const firstVal = Object.values(parsed)[0];
    if (typeof firstVal === 'string') return firstVal.length > 80 ? firstVal.slice(0, 80) + '…' : firstVal;
  } catch {
    // not json
  }
  return input.length > 80 ? input.slice(0, 80) + '…' : input;
}

export function ToolCallCard({ toolCalls }: ToolCallChainProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const chainItems: ThoughtChainItemType[] = useMemo(() => {
    return toolCalls.map((tc) => {
      const contentParts: React.ReactNode[] = [];

      if (tc.input) {
        contentParts.push(
          <details key="input" style={{ margin: 0 }}>
            <summary style={{ fontSize: 12, color: token.colorTextSecondary, cursor: 'pointer', userSelect: 'none' }}>
              {t('chat.inspector.toolInput', '输入参数')}
            </summary>
            <pre
              style={{
                margin: '4px 0 0',
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
              {tc.input}
            </pre>
          </details>,
        );
      }

      if (tc.output) {
        contentParts.push(
          <details key="output" style={{ margin: 0 }}>
            <summary style={{ fontSize: 12, color: token.colorTextSecondary, cursor: 'pointer', userSelect: 'none' }}>
              {t('chat.inspector.toolOutput', '执行结果')}
            </summary>
            <pre
              style={{
                margin: '4px 0 0',
                padding: 8,
                fontSize: 11,
                fontFamily: 'monospace',
                backgroundColor: token.colorBgTextHover,
                borderRadius: token.borderRadius,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 200,
                overflow: 'auto',
                color: tc.isError ? token.colorError : undefined,
              }}
            >
              {tc.output}
            </pre>
          </details>,
        );
      }

      return {
        key: tc.toolUseId,
        icon: getToolIcon(tc.toolName),
        title: tc.toolName,
        description: (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, fontFamily: 'monospace' }}
            ellipsis
          >
            {getInputSummary(tc.input)}
          </Typography.Text>
        ),
        status: statusMap[tc.status] || 'loading',
        collapsible: tc.status === 'success' || tc.status === 'error' || tc.status === 'cancelled',
        content: contentParts.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {contentParts}
          </div>
        ) : undefined,
      } satisfies ThoughtChainItemType;
    });
  }, [toolCalls, token, t]);

  if (chainItems.length === 0) return null;

  return (
    <div style={{ margin: '4px 0 8px' }}>
      <ThoughtChain
        items={chainItems}
        line="dashed"
        styles={{
          item: { padding: '4px 0' },
          itemContent: { fontSize: 12 },
        }}
      />
    </div>
  );
}
