export interface MemoryRetrievedItem {
  content: string;
  score: number;
  rerankScore?: number;
  document_id: string;
  /** Chunk ID within the vector store */
  id: string;
  /** Human-readable document name (knowledge items only) */
  document_name?: string;
}

export interface MemorySourceResult {
  source_type: 'knowledge' | 'memory';
  container_id: string;
  items: MemoryRetrievedItem[];
}

export interface RagSourceError {
  source_type: 'knowledge' | 'memory';
  container_id: string;
  message: string;
}

export interface RagSourceEmptyResult {
  source_type: 'knowledge' | 'memory';
  container_id: string;
  reason: 'no_candidates' | 'threshold_filtered' | string;
}

export interface ContextDiagnostic {
  code: string;
  sourceType: string;
  containerId?: string | null;
  args?: Record<string, unknown>;
}

export interface RagContextRetrievedEvent {
  conversation_id: string;
  message_id?: string | null;
  stream_id?: string | null;
  sources: MemorySourceResult[];
  errors?: RagSourceError[];
  empty_results?: RagSourceEmptyResult[];
  emptyResults?: RagSourceEmptyResult[];
  diagnostics?: ContextDiagnostic[];
}

export function translateDiagnosticError(
  content: string | undefined,
  t: (key: string) => string,
  fallbackKey: string,
): string {
  if (!content) return t(fallbackKey);
  const key = `errors.${content}`;
  const translated = t(key);
  return translated === key ? content : translated;
}

function escapeTagText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeTagAttr(value: string): string {
  return escapeTagText(value).replace(/"/g, '&quot;');
}

export function formatRagFailureMessage(message?: string): string {
  const reason = message?.trim() ?? '';
  if (!reason) return '检索失败';
  if (reason.startsWith('检索失败')) return reason;
  return `检索失败：${reason}`;
}

/**
 * Build a `<knowledge-retrieval>` custom tag for markstream-react rendering.
 */
export function buildKnowledgeTag(
  status: 'searching' | 'done' | 'error' | 'empty',
  sources?: MemorySourceResult[] | string,
): string {
  if (status === 'searching') {
    return '<knowledge-retrieval status="searching" data-aqbot="1"></knowledge-retrieval>';
  }
  if (status === 'empty') {
    const reason = typeof sources === 'string' ? sources : '';
    const reasonAttr = reason ? ` reason="${escapeTagAttr(reason)}"` : '';
    return `<knowledge-retrieval status="empty" data-aqbot="1"${reasonAttr}></knowledge-retrieval>`;
  }
  if (status === 'error') {
    const message = formatRagFailureMessage(typeof sources === 'string' ? sources : '');
    return `<knowledge-retrieval status="error" data-aqbot="1">${escapeTagText(message)}</knowledge-retrieval>`;
  }
  const json = JSON.stringify(sources ?? []);
  return `<knowledge-retrieval status="done" data-aqbot="1">\n${json}\n</knowledge-retrieval>\n\n`;
}

/**
 * Build a `<memory-retrieval>` custom tag for markstream-react rendering.
 */
export function buildMemoryTag(
  status: 'searching' | 'done' | 'error' | 'empty',
  sources?: MemorySourceResult[] | string,
): string {
  if (status === 'searching') {
    return '<memory-retrieval status="searching" data-aqbot="1"></memory-retrieval>';
  }
  if (status === 'empty') {
    const reason = typeof sources === 'string' ? sources : '';
    const reasonAttr = reason ? ` reason="${escapeTagAttr(reason)}"` : '';
    return `<memory-retrieval status="empty" data-aqbot="1"${reasonAttr}></memory-retrieval>`;
  }
  if (status === 'error') {
    const message = formatRagFailureMessage(typeof sources === 'string' ? sources : '');
    return `<memory-retrieval status="error" data-aqbot="1">${escapeTagText(message)}</memory-retrieval>`;
  }
  const json = JSON.stringify(sources ?? []);
  return `<memory-retrieval status="done" data-aqbot="1">\n${json}\n</memory-retrieval>\n\n`;
}
