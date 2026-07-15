import type { ResourceInvalidationReason } from '@/lib/resourceState';
import { clearLegacyAvatarSourceCache } from '@/lib/legacyAvatarMedia';
import { invalidateAllModuleResources } from '@/lib/moduleResource';
import { clearStoredMediaSourceCache } from '@/lib/storedMedia';
import { invalidateAgentResources } from './agentStore';
import { useCategoryStore } from './categoryStore';
import { invalidateConversationMessageCache, useConversationStore } from './conversationStore';
import { useDrawingStore } from './drawingStore';
import { useFileStore } from './fileStore';
import { useGatewayStore } from './gatewayStore';
import { useKnowledgeStore } from './knowledgeStore';
import { useMemoryStore } from './memoryStore';
import { useMcpStore } from './mcpStore';
import { useProviderStore } from './providerStore';
import { useRoleStore } from './roleStore';
import { useSearchStore } from './searchStore';
import { useSettingsStore } from './settingsStore';
import { useSkillStore } from './skillStore';

export function invalidateApplicationResources(reason: ResourceInvalidationReason): void {
  if (reason === 'restore') {
    useConversationStore.getState().setActiveConversation(null);
    useConversationStore.setState({ conversations: [], archivedConversations: [] });
    useDrawingStore.setState({
      generations: [],
      references: [],
      editSourceImage: null,
      editMaskFileId: null,
      editMaskFile: null,
      editPreviewUrl: null,
    });
  }
  invalidateConversationMessageCache();
  clearLegacyAvatarSourceCache();
  clearStoredMediaSourceCache();
  invalidateAllModuleResources();
  invalidateAgentResources(reason === 'restore');
  useConversationStore.getState().invalidateConversations(reason);
  useProviderStore.getState().invalidateProviders(reason);
  useCategoryStore.getState().invalidateCategories(reason);
  useDrawingStore.getState().invalidateHistory(reason);
  useFileStore.getState().invalidateFiles(reason);
  useGatewayStore.getState().invalidateGatewayResources(reason);
  useKnowledgeStore.getState().invalidateBases(reason);
  useKnowledgeStore.getState().invalidateDocuments(reason);
  useMemoryStore.getState().invalidateNamespaces(reason);
  useMemoryStore.getState().invalidateItems(reason);
  useMcpStore.getState().invalidateServers(reason);
  useSearchStore.getState().invalidateProviders(reason);
  useSettingsStore.getState().invalidateSettings(reason);
  useRoleStore.getState().invalidateRoles(reason);
  useSkillStore.getState().invalidateSkills(reason);
}
