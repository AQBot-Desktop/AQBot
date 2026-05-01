export type IndexingStatus = 'pending' | 'indexing' | 'ready' | 'failed';
export type MemoryScope = 'global' | 'project';
export type MemorySource = 'manual' | 'auto_extract';

export type KnowledgeBase = {
  id: string;
  name: string;
  description?: string;
  embeddingProvider?: string;
  enabled: boolean;
  iconType?: string;
  iconValue?: string;
  sortOrder: number;
  embeddingDimensions?: number;
  retrievalThreshold?: number;
  retrievalTopK?: number;
  rerankProvider?: string;
  rerankCandidateK?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  separator?: string;
};

export type KnowledgeDocument = {
  id: string;
  knowledgeBaseId: string;
  title: string;
  sourcePath: string;
  mimeType: string;
  sizeBytes: number;
  indexingStatus: IndexingStatus;
  docType: string;
  indexError?: string;
};

export type RetrievalHit = {
  id: string;
  conversationId: string;
  messageId: string;
  knowledgeBaseId: string;
  documentId: string;
  chunkRef: string;
  score: number;
  preview: string;
};

export type CreateKnowledgeBaseInput = {
  name: string;
  description?: string;
  embeddingProvider?: string;
  enabled?: boolean;
};

export type UpdateKnowledgeBaseInput = Partial<CreateKnowledgeBaseInput> & {
  iconType?: string | null;
  iconValue?: string | null;
  updateIcon?: boolean;
  embeddingDimensions?: number;
  updateEmbeddingDimensions?: boolean;
  retrievalThreshold?: number;
  updateRetrievalThreshold?: boolean;
  retrievalTopK?: number;
  updateRetrievalTopK?: boolean;
  rerankProvider?: string;
  updateRerankProvider?: boolean;
  rerankCandidateK?: number;
  updateRerankCandidateK?: boolean;
  chunkSize?: number;
  updateChunkSize?: boolean;
  chunkOverlap?: number;
  updateChunkOverlap?: boolean;
  separator?: string;
  updateSeparator?: boolean;
};
