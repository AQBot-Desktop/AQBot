export type ContextSourceType = 'attachment' | 'search' | 'knowledge' | 'memory' | 'tool';

export type ContextSource = {
  id: string;
  conversationId: string;
  messageId?: string;
  type: ContextSourceType;
  refId: string;
  title: string;
  enabled: boolean;
  summary?: string;
};

export type ConversationBranch = {
  id: string;
  conversationId: string;
  parentMessageId: string;
  branchLabel: string;
  branchIndex: number;
  comparedMessageIds?: string[];
  createdAt: string;
};

export type SearchPolicy = {
  enabled: boolean;
  searchProviderId?: string;
  queryMode: 'manual' | 'auto';
  resultLimit: number;
};

export type ToolBinding = {
  serverIds: string[];
  defaultTools?: string[];
  approvalMode: 'inherit' | 'ask' | 'allow_safe';
};

export type KnowledgeBinding = {
  knowledgeBaseIds: string[];
  autoAttach: boolean;
};

export type MemoryPolicy = {
  enabled: boolean;
  namespaceId?: string;
  writeBack: boolean;
};

export type ContextToggleState = {
  searchEnabled: boolean;
  searchProviderId?: string;
  enabledKnowledgeBaseIds: string[];
  enabledMcpServerIds: string[];
  enabledToolNames?: string[];
  memoryEnabled: boolean;
  memoryNamespaceId?: string;
  memoryWriteBack: boolean;
  disabledContextSourceIds?: string[];
};

export type ConversationWorkspaceSnapshot = {
  searchPolicy: SearchPolicy;
  toolBinding: ToolBinding;
  knowledgeBinding: KnowledgeBinding;
  memoryPolicy: MemoryPolicy;
  toggles: ContextToggleState;
  researchMode: boolean;
  pinnedArtifactIds: string[];
};

export type ContextOverrideInput = {
  searchEnabled?: boolean;
  searchProviderId?: string | null;
  enabledKnowledgeBaseIds?: string[];
  enabledMcpServerIds?: string[];
  enabledToolNames?: string[];
  memoryEnabled?: boolean;
  memoryNamespaceId?: string | null;
  memoryWriteBack?: boolean;
  disabledContextSourceIds?: string[];
  researchMode?: boolean;
};

export type CreateConversationInput = {
  title: string;
  providerId: string;
  modelId: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  workspaceSnapshot?: ConversationWorkspaceSnapshot;
};

export type UpdateConversationInput = {
  title?: string;
  providerId?: string;
  modelId?: string;
  workspaceSnapshot?: ConversationWorkspaceSnapshot;
  activeBranchId?: string | null;
  activeArtifactId?: string | null;
  researchMode?: boolean;
};

export type SendMessageInput = {
  conversationId: string;
  content: string;
  attachments?: AttachmentInput[];
  contextOverride?: ContextOverrideInput;
};

export type AttachmentInput = {
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
};

export type CompareResponsesResult = {
  leftMessage: { id: string; content: string };
  rightMessage: { id: string; content: string };
};
