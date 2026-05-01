import { useState } from 'react';
import { theme } from 'antd';
import { BookOpen, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import type { NodeComponentProps } from 'markstream-react';
import { useTranslation } from 'react-i18next';
import type { MemorySourceResult, MemoryRetrievedItem } from '@/lib/memoryUtils';

type KnowledgeRetrievalNodeData = {
  type: 'knowledge-retrieval';
  content?: string;
  attrs?: Record<string, string> | [string, string][];
  loading?: boolean;
};

function getAttrValue(
  attrs: KnowledgeRetrievalNodeData['attrs'],
  key: string,
): string | undefined {
  if (!attrs) return undefined;
  if (Array.isArray(attrs)) {
    const entry = attrs.find(([name]) => name === key);
    return entry?.[1];
  }
  return attrs[key];
}

function truncateContent(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

function formatRetrievalScore(item: MemoryRetrievedItem, digits: number): string {
  if (typeof item.rerankScore === 'number') {
    return item.rerankScore.toFixed(digits);
  }
  return (1 / (1 + item.score)).toFixed(digits);
}

export function KnowledgeRetrievalNode(props: NodeComponentProps<KnowledgeRetrievalNodeData>) {
  const { node } = props;
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (!node) return null;

  const status = getAttrValue(node.attrs, 'status') ?? (node.loading ? 'searching' : 'done');

  let sources: MemorySourceResult[] = [];
  if (node.content) {
    try {
      const parsed = JSON.parse(node.content);
      if (Array.isArray(parsed)) sources = parsed;
    } catch {
      // invalid JSON
    }
  }

  const totalItems = sources.reduce((sum, s) => sum + s.items.length, 0);

  // Searching state
  if (status === 'searching') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          marginBottom: 8,
          borderRadius: 8,
          backgroundColor: token.colorFillQuaternary,
        }}
      >
        <span
          className="animate-spin"
          style={{ display: 'inline-flex', width: 16, height: 16 }}
        >
          <BookOpen size={16} style={{ color: token.colorPrimary }} />
        </span>
        <span style={{ color: token.colorTextSecondary, fontSize: 13 }}>
          {t('chat.knowledgeRetrieval.searching')}
        </span>
      </div>
    );
  }

  // Error state
  if (status === 'error') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          marginBottom: 8,
          borderRadius: 8,
          backgroundColor: token.colorErrorBg,
          color: token.colorError,
          fontSize: 13,
        }}
      >
        <AlertCircle size={16} />
        <span>{node.content || t('chat.knowledgeRetrieval.error')}</span>
      </div>
    );
  }

  // Done state — no results
  if (totalItems === 0) return null;

  return (
    <div
      style={{
        marginBottom: 8,
        borderRadius: 8,
        border: `1px solid ${token.colorBorderSecondary}`,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          cursor: 'pointer',
          backgroundColor: token.colorFillQuaternary,
          userSelect: 'none',
        }}
      >
        <BookOpen size={14} style={{ color: token.colorPrimary }} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          {t('chat.knowledgeRetrieval.resultsCount', {
            count: totalItems,
            defaultValue: '检索到 {{count}} 条知识',
          })}
        </span>
        <span style={{ marginLeft: 'auto', color: token.colorTextTertiary }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </div>

      {/* Per-item overview */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '6px 12px',
          flexWrap: 'wrap',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {sources.flatMap((src, si) =>
          src.items.map((item, ii) => (
            <span
              key={`${si}-${ii}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                fontSize: 11,
                borderRadius: 4,
                backgroundColor: token.colorFillSecondary,
                color: token.colorTextSecondary,
              }}
            >
              <BookOpen size={10} style={{ flexShrink: 0 }} />
              <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.document_name || item.document_id?.slice(0, 8) || '—'}
              </span>
              {item.id && <span style={{ opacity: 0.5 }}>#{item.id.slice(0, 6)}</span>}
              <span style={{ color: token.colorPrimary, fontFamily: 'monospace' }}>
                {formatRetrievalScore(item, 3)}
              </span>
            </span>
          )),
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          style={{
            padding: '8px 12px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          {sources.map((src, si) =>
            src.items.map((item: MemoryRetrievedItem, ii: number) => (
              <div
                key={`${si}-${ii}`}
                style={{
                  marginBottom: ii < src.items.length - 1 || si < sources.length - 1 ? 8 : 0,
                  fontSize: 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    marginBottom: 2,
                  }}
                >
                  <BookOpen size={12} style={{ color: token.colorPrimary, flexShrink: 0 }} />
                  <span style={{ fontWeight: 500, color: token.colorText }}>
                    {item.document_name || item.document_id?.slice(0, 8) || '—'}
                  </span>
                  {item.id && (
                    <span style={{ fontSize: 10, color: token.colorTextQuaternary }}>
                      #{item.id.slice(0, 8)}
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 10,
                      color: token.colorTextQuaternary,
                    }}
                  >
                    {formatRetrievalScore(item, 4)}
                  </span>
                </div>
                <p
                  style={{
                    margin: '2px 0 0 0',
                    color: token.colorTextSecondary,
                    lineHeight: 1.5,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {truncateContent(item.content, 200)}
                </p>
              </div>
            )),
          )}
        </div>
      )}
    </div>
  );
}
