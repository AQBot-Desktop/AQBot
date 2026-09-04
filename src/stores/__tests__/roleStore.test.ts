import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketplaceRole, Role, RoleMarketplaceSource } from '@/types';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

const installedRole: Role = {
  id: 'role-1',
  name: 'English Translator',
  description: 'Translate text',
  system_prompt: 'Translate text',
  opening_message: null,
  opening_questions: [],
  tags: ['text'],
  avatar: '💬',
  avatar_type: 'emoji',
  avatar_value: '💬',
  temperature: 0.2,
  top_p: 0.8,
  enabled_mcp_server_ids: [],
  enabled_skill_names: [],
  enabled_knowledge_base_ids: [],
  enabled_memory_namespace_ids: [],
  source_kind: 'prompts-chat',
  source_ref: 'prompts-chat://english-translator',
  created_at: 1,
  updated_at: 1,
};

const marketplaceRole: MarketplaceRole = {
  id: 'market-role',
  name: 'English Translator',
  description: 'Translate text',
  tags: ['text'],
  avatar: '💬',
  avatar_type: 'emoji',
  avatar_value: '💬',
  temperature: null,
  top_p: null,
  source_kind: 'prompts-chat',
  source_ref: 'prompts-chat://english-translator',
  marketplace_source: 'prompts-chat',
  installed: false,
};

const marketplaceSources: RoleMarketplaceSource[] = [
  { id: 'prompts-chat', name: 'prompts.chat', default: true },
  { id: 'plexpt-zh', name: 'PlexPt 中文', default: false },
];

describe('roleStore', () => {
  beforeEach(async () => {
    invokeMock.mockReset();
    vi.resetModules();
    const { useRoleStore } = await import('../roleStore');
    useRoleStore.setState({
      roles: [],
      marketplaceRoles: [marketplaceRole],
      marketplaceSources: [],
      selectedMarketplaceSource: 'prompts-chat',
      loading: false,
      marketplaceLoading: false,
    });
  });

  it('loads marketplace sources and keeps prompts.chat selected by default', async () => {
    invokeMock.mockResolvedValueOnce(marketplaceSources);
    const { useRoleStore } = await import('../roleStore');

    await useRoleStore.getState().loadMarketplaceSources();

    expect(invokeMock).toHaveBeenCalledWith('list_role_marketplace_sources');
    expect(useRoleStore.getState().marketplaceSources).toEqual(marketplaceSources);
    expect(useRoleStore.getState().selectedMarketplaceSource).toBe('prompts-chat');
    expect(useRoleStore.getState().marketplaceSources.some((source) => source.id === 'aqbot')).toBe(false);
    expect(useRoleStore.getState().marketplaceSources.some((source) => source.id === 'lobehub')).toBe(false);
  });

  it('searches marketplace with the selected source', async () => {
    invokeMock.mockResolvedValueOnce([marketplaceRole]);
    const { useRoleStore } = await import('../roleStore');
    useRoleStore.getState().setMarketplaceSource('plexpt-zh');

    await useRoleStore.getState().searchMarketplace('写作');

    expect(invokeMock).toHaveBeenCalledWith('search_role_marketplace', {
      sourceId: 'plexpt-zh',
      query: '写作',
    });
    expect(useRoleStore.getState().marketplaceRoles).toEqual([marketplaceRole]);
  });

  it('clears stale marketplace results while loading and ignores older responses', async () => {
    let resolveFirst!: (roles: MarketplaceRole[]) => void;
    let resolveSecond!: (roles: MarketplaceRole[]) => void;
    const first = new Promise<MarketplaceRole[]>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<MarketplaceRole[]>((resolve) => { resolveSecond = resolve; });
    const newerRole = { ...marketplaceRole, id: 'newer-role', source_ref: 'prompts-chat://newer' };
    invokeMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const { useRoleStore } = await import('../roleStore');
    const firstSearch = useRoleStore.getState().searchMarketplace('old');

    expect(useRoleStore.getState().marketplaceLoading).toBe(true);
    expect(useRoleStore.getState().marketplaceRoles).toEqual([]);

    const secondSearch = useRoleStore.getState().searchMarketplace('new');
    resolveSecond([newerRole]);
    await secondSearch;
    expect(useRoleStore.getState().marketplaceRoles).toEqual([newerRole]);

    resolveFirst([marketplaceRole]);
    await firstSearch;
    expect(useRoleStore.getState().marketplaceRoles).toEqual([newerRole]);
    expect(useRoleStore.getState().marketplaceLoading).toBe(false);
  });

  it('adds installed role locally and marks marketplace item installed', async () => {
    invokeMock.mockResolvedValueOnce(installedRole);
    const { useRoleStore } = await import('../roleStore');

    await useRoleStore.getState().installRole('prompts-chat', 'prompts-chat://english-translator');

    expect(invokeMock).toHaveBeenCalledWith('install_role', {
      sourceKind: 'prompts-chat',
      sourceRef: 'prompts-chat://english-translator',
    });
    expect(useRoleStore.getState().roles).toEqual([installedRole]);
    expect(useRoleStore.getState().marketplaceRoles[0].installed).toBe(true);
  });
});
