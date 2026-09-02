import { CONV_ICON_KEY } from '@/lib/convIcon';
import { ROLE_INTRO_KEY, saveRoleIntro } from '@/lib/roleIntro';
import type { Conversation, Role, UpdateConversationInput } from '@/types';

export const CONV_ROLE_ID_KEY = (conversationId: string) => `aqbot_conv_role_${conversationId}`;

export class ConversationRoleStorageError extends Error {
  constructor(message = 'Failed to access conversation role binding') {
    super(message);
    this.name = 'ConversationRoleStorageError';
  }
}

export function getConversationRoleId(conversationId: string): string | null {
  return readLocalStorageItem(CONV_ROLE_ID_KEY(conversationId));
}

function readLocalStorageItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    throw new ConversationRoleStorageError('Failed to read conversation role binding');
  }
}

function writeLocalStorageItem(key: string, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    throw new ConversationRoleStorageError('Failed to save conversation role binding');
  }
}

export function setConversationRoleId(conversationId: string, roleId: string | null) {
  writeLocalStorageItem(CONV_ROLE_ID_KEY(conversationId), roleId);
}

interface ConversationRoleMetadataSnapshot {
  roleId: string | null;
  iconRaw: string | null;
  introRaw: string | null;
}

function captureConversationRoleMetadata(conversationId: string): ConversationRoleMetadataSnapshot {
  return {
    roleId: readLocalStorageItem(CONV_ROLE_ID_KEY(conversationId)),
    iconRaw: readLocalStorageItem(CONV_ICON_KEY(conversationId)),
    introRaw: readLocalStorageItem(ROLE_INTRO_KEY(conversationId)),
  };
}

function restoreConversationRoleMetadata(
  conversationId: string,
  snapshot: ConversationRoleMetadataSnapshot,
) {
  writeLocalStorageItem(CONV_ROLE_ID_KEY(conversationId), snapshot.roleId);
  writeLocalStorageItem(CONV_ICON_KEY(conversationId), snapshot.iconRaw);
  writeLocalStorageItem(ROLE_INTRO_KEY(conversationId), snapshot.introRaw);
}

/** Write role metadata, then persist. Restore the previous snapshot if persist fails. */
export async function applyRoleWithRollback(
  conversationId: string,
  role: Role,
  persist: () => Promise<void>,
): Promise<void> {
  const snapshot = captureConversationRoleMetadata(conversationId);
  try {
    syncConversationRoleMetadata(conversationId, role);
    await persist();
  } catch (error) {
    try {
      restoreConversationRoleMetadata(conversationId, snapshot);
    } catch (restoreError) {
      console.error('[applyRole] failed to roll back conversation role metadata', restoreError);
    }
    throw error;
  }
}

function getRoleAvatar(role: Pick<Role, 'avatar' | 'avatar_type' | 'avatar_value'>) {
  const value = role.avatar_value ?? role.avatar ?? '';
  const type =
    role.avatar_type
    ?? (value
      ? (value.startsWith('http://') || value.startsWith('https://') ? 'url' : 'emoji')
      : null);
  return { type, value };
}

/** Persist avatar icon + opening intro for a conversation after a role is applied. */
export function syncConversationRoleMetadata(conversationId: string, role: Role) {
  setConversationRoleId(conversationId, role.id);
  const avatar = getRoleAvatar(role);
  try {
    if (avatar.type && avatar.value) {
      localStorage.setItem(
        CONV_ICON_KEY(conversationId),
        JSON.stringify({ type: avatar.type, value: avatar.value }),
      );
    } else {
      localStorage.removeItem(CONV_ICON_KEY(conversationId));
    }
  } catch {
    // ignore
  }
  saveRoleIntro(conversationId, role);
}

export interface BuildApplyRoleUpdateOptions {
  /** When true (default), write MCP ids if the role defines a non-empty list. */
  applyMcp?: boolean;
  /** When true (default), the caller should enable listed skills globally. */
  applySkills?: boolean;
  /** Current conversation mode. Agent execution is preserved so role skills can run. */
  currentMode?: Conversation['mode'];
}

export function resolveChatModeForConversation(conversationId: string): 'chat' | 'role' {
  return getConversationRoleId(conversationId) ? 'role' : 'chat';
}

function resolveModeWhenApplyingRole(currentMode?: Conversation['mode']): NonNullable<Conversation['mode']> {
  return currentMode === 'agent' ? 'agent' : 'role';
}

/**
 * Build the conversation update payload for applying a role.
 *
 * Empty capability lists do not clear existing conversation MCP/skill settings.
 */
export function buildApplyRoleUpdate(
  role: Role,
  options: BuildApplyRoleUpdateOptions = {},
): UpdateConversationInput {
  const applyMcp = options.applyMcp !== false;
  const update: UpdateConversationInput = {
    system_prompt: role.system_prompt,
    temperature: role.temperature,
    top_p: role.top_p,
    mode: resolveModeWhenApplyingRole(options.currentMode),
  };

  const mcpIds = role.enabled_mcp_server_ids ?? [];
  if (applyMcp && mcpIds.length > 0) {
    update.enabled_mcp_server_ids = [...mcpIds];
  }

  return update;
}

export function roleSkillNames(role: Role): string[] {
  return (role.enabled_skill_names ?? []).map((name) => name.trim()).filter(Boolean);
}
