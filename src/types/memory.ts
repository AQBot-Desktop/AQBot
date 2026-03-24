import type { MemoryScope, MemorySource } from './knowledge';

export type MemoryNamespace = {
  id: string;
  name: string;
  scope: MemoryScope;
  embeddingProvider?: string;
};

export type MemoryItem = {
  id: string;
  namespaceId: string;
  title: string;
  content: string;
  source: MemorySource;
  updatedAt: string;
};

export type CreateMemoryNamespaceInput = {
  name: string;
  scope: MemoryScope;
  embeddingProvider?: string;
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
};
