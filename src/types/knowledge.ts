export type IndexingStatus = 'pending' | 'indexing' | 'ready' | 'failed';
export type MemoryScope = 'global' | 'project';
export type MemorySource = 'manual' | 'auto_extract';

export type KnowledgeBase = {
  id: string;
  name: string;
  description?: string;
  embeddingProvider?: string;
  enabled: boolean;
};

export type KnowledgeDocument = {
  id: string;
  knowledgeBaseId: string;
  title: string;
  sourcePath: string;
  mimeType: string;
  sizeBytes: number;
  indexingStatus: IndexingStatus;
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

export type UpdateKnowledgeBaseInput = Partial<CreateKnowledgeBaseInput>;
