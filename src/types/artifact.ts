export type ArtifactKind = 'draft' | 'note' | 'report' | 'snippet' | 'checklist';
export type ArtifactFormat = 'markdown' | 'text' | 'json';

export type Artifact = {
  id: string;
  conversationId: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  format: ArtifactFormat;
  pinned: boolean;
  updatedAt: string;
};

export type CreateArtifactInput = {
  conversationId: string;
  sourceMessageId?: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  format: ArtifactFormat;
};

export type UpdateArtifactInput = {
  title?: string;
  content?: string;
  format?: ArtifactFormat;
  pinned?: boolean;
};
