import { useState } from 'react';
import { SyncOutlined } from '@ant-design/icons';
import { Typography, theme } from 'antd';
import {
  ChevronDown,
  CheckCircle2,
  Code,
  FileCode,
  FileText,
  FileType,
  XCircle,
  Zap,
} from 'lucide-react';
import type { NodeComponentProps } from 'markstream-react';
import { useTranslation } from 'react-i18next';
import { getCustomAttr, type CustomNodeAttrs } from '@/components/chat/chatMarkdownShared';
import { acpToolStateKey, useAcpStore } from '@/stores/acpStore';

const toolCallIcons: Record<string, React.ReactNode> = {
  bash: <Code size={14} />,
  shell: <Code size={14} />,
  terminal: <Code size={14} />,
  execute: <Code size={14} />,
  write: <FileCode size={14} />,
  read: <FileText size={14} />,
  edit: <FileCode size={14} />,
  glob: <FileType size={14} />,
  grep: <FileText size={14} />,
  ls: <FileType size={14} />,
  search: <FileText size={14} />,
};

function getInlineToolIcon(toolName: string): React.ReactNode {
  const lower = toolName.toLowerCase();
  for (const [key, icon] of Object.entries(toolCallIcons)) {
    if (lower.includes(key)) return icon;
  }
  return <Zap size={14} />;
}

function decodeXmlTextEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function summaryFromToolCallNode(node: { content?: string; children?: unknown }): string {
  const raw = String(node.content ?? '');
  if ('children' in node) return raw;
  return decodeXmlTextEntities(raw);
}

const toolCallStatusColors: Record<string, string> = {
  queued: '#faad14',
  running: '#1890ff',
  success: '#52c41a',
  error: '#ff4d4f',
  cancelled: '#8c8c8c',
};

/**
 * Inline tool-call chip for ACP messages — mirrors ChatView `ToolCallNode`
 * but reads live status/input/output from `acpStore`.
 */
export function AcpToolCallNode(props: NodeComponentProps<{
  type: 'tool-call';
  content: string;
  attrs?: CustomNodeAttrs;
}>) {
  const { node } = props;
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const execId = getCustomAttr(node.attrs, 'id') ?? '';
  const messageId = getCustomAttr(node.attrs, 'message') ?? '';
  const tc = useAcpStore((state) => {
    const threadId = state.activeThreadId ?? '';
    const scoped = messageId
      ? state.toolCalls[acpToolStateKey(threadId, execId, messageId)]
      : undefined;
    if (scoped) return scoped;
    const legacy = state.toolCalls[acpToolStateKey(threadId, execId)] ?? state.toolCalls[execId];
    if (legacy && (!messageId || !legacy.messageId || legacy.messageId === messageId)) return legacy;
    return Object.values(state.toolCalls)
      .reverse()
      .find((tool) => tool.threadId === threadId
        && tool.toolCallId === execId
        && (!messageId || tool.messageId === messageId));
  });
  const [expanded, setExpanded] = useState(false);

  const toolName = getCustomAttr(node.attrs, 'name') ?? tc?.toolName ?? 'tool';
  const summary = summaryFromToolCallNode(node);

  // Legacy history can contain a marker without persisted tool metadata. Do
  // not claim success when the actual terminal state is unknown.
  const status = tc?.status ?? 'unknown';
  const statusLabel = status === 'queued'
    ? t('agentPage.interactionToolQueued')
    : status === 'running'
      ? t('agentPage.interactionToolRunning')
      : status === 'success'
        ? t('agentPage.interactionToolSuccess')
        : status === 'error'
          ? t('agentPage.interactionToolError')
          : status === 'cancelled'
            ? t('agentPage.interactionToolCancelled')
            : t('agentPage.interactionToolUnknown');
  const statusColor = toolCallStatusColors[status] || token.colorTextSecondary;
  const isLoading = status === 'queued' || status === 'running';
  const output = tc?.output === 'aqbot:questionnaire:accepted'
    ? t('agentPage.interactionAnswersSubmitted')
    : tc?.output === 'aqbot:questionnaire:declined'
      ? t('agentPage.interactionDeclineAnswers')
      : tc?.output === 'aqbot:questionnaire:chat_about_this'
        ? t('agentPage.interactionChatAboutThis')
        : tc?.output === 'aqbot:questionnaire:skip_interview'
          ? t('agentPage.interactionSkipInterview')
          : tc?.output;
  const hasDetails = !!(tc && (tc.input || output));
  const approvalLabel = tc?.approvalStatus === 'approved'
    ? t('agentPage.interactionApproved')
    : tc?.approvalStatus === 'denied'
      ? t('agentPage.interactionDenied')
      : tc?.approvalStatus === 'cancelled'
        ? t('agentPage.interactionCancelled')
        : tc?.approvalStatus === 'expired'
          ? t('agentPage.interactionExpired')
          : null;
  const approvalColor = tc?.approvalStatus === 'approved'
    ? token.colorSuccess
    : tc?.approvalStatus === 'denied'
      ? token.colorError
      : token.colorTextSecondary;
  const detailsId = `acp-tool-details-${`${messageId}-${execId}`.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const row = (
    <>
      <span style={{ color: statusColor, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        {getInlineToolIcon(toolName)}
      </span>
      <span style={{ fontWeight: 500, flexShrink: 0 }} translate="no">{toolName}</span>
      {approvalLabel ? (
        <span
          style={{
            color: approvalColor,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            flexShrink: 0,
            fontSize: 12,
          }}
        >
          {tc?.approvalStatus === 'approved'
            ? <CheckCircle2 size={12} aria-hidden="true" />
            : <XCircle size={12} aria-hidden="true" />}
          {approvalLabel}
        </span>
      ) : null}
      {summary && (
        <>
          <span style={{ color: token.colorTextQuaternary }}>›</span>
          <Typography.Text
            type="secondary"
            ellipsis
            style={{ fontSize: 12, flex: 1, minWidth: 0 }}
          >
            {summary}
          </Typography.Text>
        </>
      )}
      {isLoading ? (
        <SyncOutlined style={{ fontSize: 12, color: statusColor }} spin />
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            backgroundColor: statusColor,
            flexShrink: 0,
          }}
        />
      )}
      {hasDetails ? (
        <span
          aria-hidden="true"
          style={{
            color: token.colorTextSecondary,
            display: 'flex',
            alignItems: 'center',
            flexShrink: 0,
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          <ChevronDown size={14} />
        </span>
      ) : null}
    </>
  );

  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '4px 10px',
    borderRadius: token.borderRadius,
    backgroundColor: token.colorFillQuaternary,
    border: `1px solid ${token.colorBorderSecondary}`,
    color: token.colorText,
    fontSize: 13,
    lineHeight: '20px',
    fontFamily: 'monospace',
    cursor: hasDetails ? 'pointer' : 'default',
    userSelect: 'none' as const,
    textAlign: 'start' as const,
  };

  return (
    <div style={{ margin: '4px 0' }}>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {toolName} {statusLabel}
      </span>
      {hasDetails ? (
        <button
          type="button"
          className="aqbot-acp-tool-button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`${toolName} ${statusLabel}${approvalLabel ? ` ${approvalLabel}` : ''}`}
          onClick={() => setExpanded((current) => !current)}
          style={rowStyle}
        >
          {row}
        </button>
      ) : (
        <div role="group" aria-label={`${toolName} ${statusLabel}`} style={rowStyle}>
          {row}
        </div>
      )}
      {expanded && hasDetails && tc && (
        <div
          id={detailsId}
          style={{
            margin: '2px 0 0',
            padding: '6px 10px',
            borderRadius: token.borderRadius,
            backgroundColor: token.colorFillQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderTop: 'none',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {tc.input && (
            <details style={{ margin: 0 }}>
              <summary
                style={{
                  fontSize: 12,
                  color: token.colorTextSecondary,
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                {t('chat.inspector.toolInput')}
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
            </details>
          )}
          {output && (
            <details style={{ margin: 0 }}>
              <summary
                style={{
                  fontSize: 12,
                  color: token.colorTextSecondary,
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                {t('chat.inspector.toolOutput')}
              </summary>
              <pre
                className="aqbot-chat-tool-output-pre"
                style={{
                  margin: '4px 0 0',
                  padding: 8,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  backgroundColor: token.colorBgTextHover,
                  borderRadius: token.borderRadius,
                  whiteSpace: 'pre',
                  overflow: 'auto',
                  maxHeight: 200,
                  color: tc.status === 'error' ? token.colorError : undefined,
                }}
              >
                {output}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
