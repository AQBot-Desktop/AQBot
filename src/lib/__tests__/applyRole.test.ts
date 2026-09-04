import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONV_ROLE_ID_KEY,
  ConversationRoleStorageError,
  applyRoleWithRollback,
  buildApplyRoleUpdate,
  getConversationRoleId,
  resolveChatModeForConversation,
  roleSkillNames,
  setConversationRoleId,
  syncConversationRoleMetadata,
} from '../applyRole';
import type { Role } from '@/types';

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: 'role-1',
    name: 'Demo',
    description: null,
    system_prompt: 'You are helpful',
    opening_message: null,
    opening_questions: [],
    tags: [],
    avatar: null,
    avatar_type: null,
    avatar_value: null,
    temperature: 0.3,
    top_p: 0.9,
    enabled_mcp_server_ids: [],
    enabled_skill_names: [],
    enabled_knowledge_base_ids: [],
    enabled_memory_namespace_ids: [],
    source_kind: 'local',
    source_ref: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('buildApplyRoleUpdate', () => {
  it('always sets prompt, params, and role mode', () => {
    const update = buildApplyRoleUpdate(makeRole());
    expect(update).toEqual({
      system_prompt: 'You are helpful',
      temperature: 0.3,
      top_p: 0.9,
      mode: 'role',
      enabled_knowledge_base_ids: [],
      enabled_memory_namespace_ids: [],
    });
  });

  it('always writes knowledge and memory bindings, including empty arrays, without mutating the role', () => {
    const knowledgeIds = ['kb-1'];
    const memoryIds = ['ns-1'];
    const role = makeRole({
      enabled_knowledge_base_ids: knowledgeIds,
      enabled_memory_namespace_ids: memoryIds,
    });
    const filled = buildApplyRoleUpdate(role);
    expect(filled.enabled_knowledge_base_ids).toEqual(['kb-1']);
    expect(filled.enabled_memory_namespace_ids).toEqual(['ns-1']);
    filled.enabled_knowledge_base_ids!.push('mutated');
    filled.enabled_memory_namespace_ids!.push('mutated');
    expect(role.enabled_knowledge_base_ids).toEqual(['kb-1']);
    expect(role.enabled_memory_namespace_ids).toEqual(['ns-1']);
    expect(knowledgeIds).toEqual(['kb-1']);
    expect(memoryIds).toEqual(['ns-1']);

    const empty = buildApplyRoleUpdate(makeRole({
      enabled_knowledge_base_ids: [],
      enabled_memory_namespace_ids: [],
    }));
    expect(empty.enabled_knowledge_base_ids).toEqual([]);
    expect(empty.enabled_memory_namespace_ids).toEqual([]);
  });

  it('keeps agent mode so role skills can run', () => {
    const update = buildApplyRoleUpdate(makeRole(), { currentMode: 'agent' });
    expect(update.mode).toBe('agent');
    expect(update.system_prompt).toBe('You are helpful');
  });

  it('promotes chat conversations to role mode', () => {
    expect(buildApplyRoleUpdate(makeRole(), { currentMode: 'chat' }).mode).toBe('role');
  });

  it('keeps role mode when the conversation is already a role', () => {
    expect(buildApplyRoleUpdate(makeRole(), { currentMode: 'role' }).mode).toBe('role');
  });

  it('writes mcp ids only when the role list is non-empty', () => {
    const empty = buildApplyRoleUpdate(makeRole({ enabled_mcp_server_ids: [] }));
    expect(empty.enabled_mcp_server_ids).toBeUndefined();

    const filled = buildApplyRoleUpdate(
      makeRole({ enabled_mcp_server_ids: ['mcp-a', 'mcp-b'] }),
    );
    expect(filled.enabled_mcp_server_ids).toEqual(['mcp-a', 'mcp-b']);
  });

  it('can skip mcp application', () => {
    const update = buildApplyRoleUpdate(
      makeRole({ enabled_mcp_server_ids: ['mcp-a'] }),
      { applyMcp: false },
    );
    expect(update.enabled_mcp_server_ids).toBeUndefined();
  });
});

describe('roleSkillNames', () => {
  it('trims and drops empty skill names', () => {
    expect(roleSkillNames(makeRole({
      enabled_skill_names: ['  a  ', '', 'b'],
    }))).toEqual(['a', 'b']);
  });
});

describe('resolveChatModeForConversation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores role mode when a role is bound', () => {
    localStorage.setItem(CONV_ROLE_ID_KEY('conv-1'), 'role-1');
    expect(resolveChatModeForConversation('conv-1')).toBe('role');
  });

  it('uses chat mode when no role is bound', () => {
    expect(resolveChatModeForConversation('conv-1')).toBe('chat');
  });

  it('throws when the role binding cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => getConversationRoleId('conv-1')).toThrow(ConversationRoleStorageError);
    expect(() => resolveChatModeForConversation('conv-1')).toThrow(ConversationRoleStorageError);
  });

  it('throws when the role binding cannot be saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => setConversationRoleId('conv-1', 'role-1')).toThrow(ConversationRoleStorageError);
  });

  it('aborts metadata sync before writing other keys when the binding cannot be saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if (String(key).includes('aqbot_conv_role_')) throw new Error('denied');
    });
    expect(() => syncConversationRoleMetadata('conv-1', makeRole())).toThrow(ConversationRoleStorageError);
    expect(localStorage.getItem('aqbot_conv_icon_conv-1')).toBeNull();
  });
});

describe('applyRoleWithRollback', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps new metadata after persist succeeds', async () => {
    await applyRoleWithRollback('conv-1', makeRole(), async () => {});
    expect(localStorage.getItem(CONV_ROLE_ID_KEY('conv-1'))).toBe('role-1');
  });

  it('restores the previous binding when persist fails', async () => {
    localStorage.setItem(CONV_ROLE_ID_KEY('conv-1'), 'old-role');
    localStorage.setItem('aqbot_conv_icon_conv-1', JSON.stringify({ type: 'emoji', value: '🤖' }));

    await expect(applyRoleWithRollback(
      'conv-1',
      makeRole({
        id: 'role-2',
        avatar: '🌐',
        avatar_type: 'emoji',
        avatar_value: '🌐',
      }),
      async () => {
        throw new Error('backend down');
      },
    )).rejects.toThrow('backend down');

    expect(localStorage.getItem(CONV_ROLE_ID_KEY('conv-1'))).toBe('old-role');
    expect(localStorage.getItem('aqbot_conv_icon_conv-1')).toBe(JSON.stringify({ type: 'emoji', value: '🤖' }));
  });

  it('clears a newly written binding when persist fails and none existed', async () => {
    await expect(applyRoleWithRollback('conv-1', makeRole(), async () => {
      throw new Error('backend down');
    })).rejects.toThrow('backend down');

    expect(localStorage.getItem(CONV_ROLE_ID_KEY('conv-1'))).toBeNull();
  });
});
