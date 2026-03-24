import type { SearchResultItem } from '@/types';

const SEARCH_MARKER_START = '<!-- search:';
const SEARCH_MARKER_END = ' -->';
const SEARCH_SEPARATOR = '\n---\n\n';

export interface SearchSourceTag {
  title: string;
  url: string;
}

/**
 * Format search results + user content into a single enriched message.
 * The LLM sees natural-language context; the UI can parse the hidden marker.
 */
export function formatSearchContent(
  results: SearchResultItem[],
  userContent: string,
): string {
  const sourceTags: SearchSourceTag[] = results.map((r) => ({
    title: r.title,
    url: r.url,
  }));
  const metadata = JSON.stringify({ sources: sourceTags });

  let block = `${SEARCH_MARKER_START}${metadata}${SEARCH_MARKER_END}\n`;
  block += '以下是与问题相关的网络搜索结果，请参考回答：\n\n';

  results.forEach((r, i) => {
    block += `${i + 1}. **${r.title}** - ${r.url}\n   ${r.content}\n\n`;
  });

  return `${block}${SEARCH_SEPARATOR}${userContent}`;
}

/**
 * Build a `<web-search>` custom tag for markstream-react rendering.
 */
export function buildSearchTag(
  status: 'searching' | 'done' | 'error',
  results?: SearchResultItem[],
): string {
  if (status === 'searching') {
    return '<web-search status="searching"></web-search>';
  }
  if (status === 'error') {
    return '<web-search status="error"></web-search>';
  }
  const json = JSON.stringify(
    (results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content })),
  );
  return `<web-search status="done">\n${json}\n</web-search>\n\n`;
}

export function parseSearchContent(content: string): {
  hasSearch: boolean;
  sources: SearchSourceTag[];
  userContent: string;
} {
  if (!content.startsWith(SEARCH_MARKER_START)) {
    return { hasSearch: false, sources: [], userContent: content };
  }

  const markerEndIdx = content.indexOf(SEARCH_MARKER_END);
  if (markerEndIdx === -1) {
    return { hasSearch: false, sources: [], userContent: content };
  }

  const jsonStr = content.substring(SEARCH_MARKER_START.length, markerEndIdx);
  let sources: SearchSourceTag[] = [];
  try {
    const data = JSON.parse(jsonStr);
    sources = data.sources ?? [];
  } catch {
    // corrupted marker – treat as no search
  }

  const separatorIdx = content.indexOf(SEARCH_SEPARATOR);
  const userContent =
    separatorIdx !== -1
      ? content.substring(separatorIdx + SEARCH_SEPARATOR.length)
      : content.substring(markerEndIdx + SEARCH_MARKER_END.length);

  return { hasSearch: true, sources, userContent };
}
