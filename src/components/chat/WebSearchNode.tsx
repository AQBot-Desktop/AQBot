import { useState } from 'react';
import { theme } from 'antd';
import { Search, ChevronDown, ChevronRight, ExternalLink, AlertCircle } from 'lucide-react';
import type { NodeComponentProps } from 'markstream-react';
import { useTranslation } from 'react-i18next';

interface SearchResult {
  title: string;
  url: string;
  content?: string;
}

type WebSearchNodeData = {
  type: 'web-search';
  content?: string;
  attrs?: Record<string, string> | [string, string][];
  loading?: boolean;
};

function getAttrValue(
  attrs: WebSearchNodeData['attrs'],
  key: string,
): string | undefined {
  if (!attrs) return undefined;
  if (Array.isArray(attrs)) {
    const entry = attrs.find(([name]) => name === key);
    return entry?.[1];
  }
  return attrs[key];
}

function getFavicon(url: string) {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=16`;
  } catch {
    return '';
  }
}

export function WebSearchNode(props: NodeComponentProps<WebSearchNodeData>) {
  const { node } = props;
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const status = getAttrValue(node.attrs, 'status') ?? (node.loading ? 'searching' : 'done');

  // Parse results from node content
  let results: SearchResult[] = [];
  if (node.content) {
    try {
      const parsed = JSON.parse(node.content);
      if (Array.isArray(parsed)) results = parsed;
    } catch {
      // invalid JSON
    }
  }

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
          <Search size={16} style={{ color: token.colorPrimary }} />
        </span>
        <span style={{ color: token.colorTextSecondary, fontSize: 13 }}>
          {t('chat.search.searching', '正在联网搜索...')}
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
        <span>{node.content || t('chat.search.error', '搜索失败')}</span>
      </div>
    );
  }

  // Done state — show results
  if (results.length === 0) return null;

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
        <Search size={14} style={{ color: token.colorPrimary }} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>
          {t('chat.search.resultsCount', { count: results.length })}
        </span>
        <span style={{ marginLeft: 'auto', color: token.colorTextTertiary }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </div>

      {/* Source icons row (always visible) */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '6px 12px',
          flexWrap: 'wrap',
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {results.map((r, i) => (
          <a
            key={i}
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            title={r.title}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              fontSize: 11,
              borderRadius: 4,
              backgroundColor: token.colorFillSecondary,
              color: token.colorTextSecondary,
              textDecoration: 'none',
              maxWidth: 160,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <img
              src={getFavicon(r.url)}
              width={12}
              height={12}
              alt=""
              style={{ flexShrink: 0 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
            {r.title}
          </a>
        ))}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: '8px 12px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          {results.map((r, i) => (
            <div
              key={i}
              style={{
                marginBottom: i < results.length - 1 ? 8 : 0,
                fontSize: 12,
              }}
            >
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: token.colorPrimary,
                  fontWeight: 500,
                  textDecoration: 'none',
                  marginBottom: 2,
                }}
              >
                <img
                  src={getFavicon(r.url)}
                  width={14}
                  height={14}
                  alt=""
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                {r.title}
                <ExternalLink size={10} style={{ opacity: 0.5 }} />
              </a>
              {r.content && (
                <p
                  style={{
                    margin: '2px 0 0 0',
                    color: token.colorTextSecondary,
                    lineHeight: 1.5,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {r.content}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
