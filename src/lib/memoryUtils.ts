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

export interface RagContextRetrievedEvent {
  conversation_id: string;
  message_id?: string | null;
  sources: MemorySourceResult[];
}

/**
 * Build a `<knowledge-retrieval>` custom tag for markstream-react rendering.
 */
export function buildKnowledgeTag(
  status: 'searching' | 'done' | 'error',
  sources?: MemorySourceResult[],
): string {
  if (status === 'searching') {
    return '<knowledge-retrieval status="searching" data-aqbot="1"></knowledge-retrieval>';
  }
  if (status === 'error') {
    return '<knowledge-retrieval status="error" data-aqbot="1"></knowledge-retrieval>';
  }
  const json = JSON.stringify(sources ?? []);
  return `<knowledge-retrieval status="done" data-aqbot="1">\n${json}\n</knowledge-retrieval>\n\n`;
}

/**
 * Build a `<memory-retrieval>` custom tag for markstream-react rendering.
 */
export function buildMemoryTag(
  status: 'searching' | 'done' | 'error',
  sources?: MemorySourceResult[],
): string {
  if (status === 'searching') {
    return '<memory-retrieval status="searching" data-aqbot="1"></memory-retrieval>';
  }
  if (status === 'error') {
    return '<memory-retrieval status="error" data-aqbot="1"></memory-retrieval>';
  }
  const json = JSON.stringify(sources ?? []);
  return `<memory-retrieval status="done" data-aqbot="1">\n${json}\n</memory-retrieval>\n\n`;
}
