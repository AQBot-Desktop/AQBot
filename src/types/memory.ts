import type { MemoryScope, MemorySource } from './knowledge';

export type MemoryNamespace = {
  id: string;
  name: string;
  scope: MemoryScope;
  embeddingProvider?: string;
  embeddingDimensions?: number;
  retrievalThreshold?: number;
  retrievalTopK?: number;
  iconType?: string;
  iconValue?: string;
  sortOrder: number;
  activationMode?: 'tool_only' | 'auto';
  migrationReviewRequired?: boolean;
};

export const MEMORY_L1_SIDEBAR_ID = 'aqbot-memory-l1';

export type MemoryL1 = {
  enabled: boolean;
  markdown: string;
  revision: number;
  sortOrder: number;
  updatedAt: string;
};

export type SaveMemoryL1Input = {
  enabled: boolean;
  markdown: string;
  revision: number;
};

export type MemoryItem = {
  id: string;
  namespaceId: string;
  title: string;
  content: string;
  source: MemorySource;
  indexStatus: string; // pending | indexing | ready | failed | skipped
  indexError?: string;
  updatedAt: string;
};

export type CreateMemoryNamespaceInput = {
  name: string;
  scope: MemoryScope;
  embeddingProvider?: string;
  embeddingDimensions?: number;
  retrievalThreshold?: number;
  retrievalTopK?: number;
  activationMode?: 'tool_only' | 'auto';
};

export type CreateMemoryItemInput = {
  namespaceId: string;
  title: string;
  content: string;
  source?: MemorySource;
};

export type UpdateMemoryItemInput = {
  title?: string;
  content?: string;
};

export type UpdateMemoryNamespaceInput = {
  name?: string;
  embeddingProvider?: string;
  updateEmbeddingProvider?: boolean;
  embeddingDimensions?: number;
  updateEmbeddingDimensions?: boolean;
  retrievalThreshold?: number;
  updateRetrievalThreshold?: boolean;
  retrievalTopK?: number;
  updateRetrievalTopK?: boolean;
  iconType?: string;
  iconValue?: string;
  updateIcon?: boolean;
  sortOrder?: number;
  activationMode?: 'tool_only' | 'auto';
  updateActivationMode?: boolean;
  migrationReviewRequired?: boolean;
  updateMigrationReviewRequired?: boolean;
};
