import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type { EnsureLoadedOptions, ResourceInvalidationReason, ResourceMeta } from '@/lib/resourceState';
import type { CreateRoleInput, MarketplaceRole, Role, RoleMarketplaceSource, UpdateRoleInput } from '@/types';

const DEFAULT_MARKETPLACE_SOURCE = 'prompts-chat';
const ROLES_RESOURCE_KEY = 'roles';
let marketplaceSearchSeq = 0;
let rolesRequest: { revision: number; promise: Promise<void> } | null = null;
let marketplaceSourcesRequest: Promise<void> | null = null;

function mutateRolesMeta(meta: ResourceMeta): ResourceMeta {
  const remainsComplete = meta.status === 'ready' && meta.key === ROLES_RESOURCE_KEY;
  return {
    status: remainsComplete ? 'ready' : 'idle',
    key: remainsComplete ? ROLES_RESOURCE_KEY : null,
    loadedAt: remainsComplete ? Date.now() : null,
    revision: meta.revision + 1,
  };
}

interface RoleState {
  roles: Role[];
  marketplaceRoles: MarketplaceRole[];
  marketplaceSources: RoleMarketplaceSource[];
  selectedMarketplaceSource: string;
  loading: boolean;
  marketplaceLoading: boolean;
  rolesMeta: ResourceMeta;
  marketplaceSourcesMeta: ResourceMeta;
  ensureRolesLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateRoles: (reason: ResourceInvalidationReason) => void;
  loadRoles: () => Promise<void>;
  ensureMarketplaceSourcesLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  loadMarketplaceSources: () => Promise<void>;
  setMarketplaceSource: (sourceId: string) => void;
  createRole: (input: CreateRoleInput) => Promise<Role>;
  updateRole: (id: string, input: UpdateRoleInput) => Promise<Role>;
  deleteRole: (id: string) => Promise<void>;
  searchMarketplace: (query: string) => Promise<void>;
  installRole: (sourceKind: string, sourceRef: string) => Promise<Role>;
}

export const useRoleStore = create<RoleState>((set, get) => ({
  roles: [],
  marketplaceRoles: [],
  marketplaceSources: [],
  selectedMarketplaceSource: DEFAULT_MARKETPLACE_SOURCE,
  loading: false,
  marketplaceLoading: false,
  rolesMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
  marketplaceSourcesMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureRolesLoaded: async (options = {}) => {
    const state = get();
    if (!options.force && isResourceFresh(state.rolesMeta, { ...options, key: ROLES_RESOURCE_KEY })) return;
    if (rolesRequest?.revision === state.rolesMeta.revision && !options.force) {
      return rolesRequest.promise;
    }
    if (rolesRequest) {
      await rolesRequest.promise;
      return get().ensureRolesLoaded(options);
    }

    const revision = state.rolesMeta.revision;
    set((state) => ({
      loading: true,
      rolesMeta: { ...state.rolesMeta, status: 'loading', key: ROLES_RESOURCE_KEY },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const roles = await invoke<Role[]>('list_roles');
        if (get().rolesMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set({
            roles,
            loading: false,
            rolesMeta: { status: 'ready', key: ROLES_RESOURCE_KEY, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        console.error('[roleStore] loadRoles failed:', e);
        if (get().rolesMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set((current) => ({
            loading: false,
            rolesMeta: { ...current.rolesMeta, status: 'error' },
          }));
        }
      } finally {
        rolesRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureRolesLoaded();
    })();
    rolesRequest = { revision, promise };
    return promise;
  },

  invalidateRoles: (_reason) => set((state) => ({
    rolesMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.rolesMeta.revision + 1,
    },
  })),

  loadRoles: () => get().ensureRolesLoaded({ force: true }),

  ensureMarketplaceSourcesLoaded: async (options = {}) => {
    const key = 'marketplace-sources';
    if (!options.force && isResourceFresh(get().marketplaceSourcesMeta, { ...options, key })) return;
    if (marketplaceSourcesRequest && !options.force) return marketplaceSourcesRequest;
    if (marketplaceSourcesRequest) {
      await marketplaceSourcesRequest;
      return get().ensureMarketplaceSourcesLoaded(options);
    }

    const revision = get().marketplaceSourcesMeta.revision;
    set((state) => ({
      marketplaceSourcesMeta: { ...state.marketplaceSourcesMeta, status: 'loading', key },
    }));
    marketplaceSourcesRequest = invoke<RoleMarketplaceSource[]>('list_role_marketplace_sources')
      .then((marketplaceSources) => {
        const selectedMarketplaceSource =
          marketplaceSources.find((source) => source.default)?.id
          ?? marketplaceSources[0]?.id
          ?? DEFAULT_MARKETPLACE_SOURCE;
        set((state) => state.marketplaceSourcesMeta.revision === revision ? {
          marketplaceSources,
          selectedMarketplaceSource,
          marketplaceSourcesMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
        } : {});
      })
      .catch((e) => {
        console.error('[roleStore] loadMarketplaceSources failed:', e);
        set((state) => state.marketplaceSourcesMeta.revision === revision ? {
          marketplaceSourcesMeta: { ...state.marketplaceSourcesMeta, status: 'error' },
        } : {});
      })
      .finally(() => {
        marketplaceSourcesRequest = null;
      });
    return marketplaceSourcesRequest;
  },

  loadMarketplaceSources: () => get().ensureMarketplaceSourcesLoaded({ force: true }),

  setMarketplaceSource: (selectedMarketplaceSource) => set({ selectedMarketplaceSource }),

  createRole: async (input) => {
    const role = await invoke<Role>('create_role', { input });
    set((s) => ({
      roles: [role, ...s.roles],
      rolesMeta: mutateRolesMeta(s.rolesMeta),
    }));
    return role;
  },

  updateRole: async (id, input) => {
    const role = await invoke<Role>('update_role', { id, input });
    set((s) => ({
      roles: s.roles.map((item) => (item.id === id ? role : item)),
      rolesMeta: mutateRolesMeta(s.rolesMeta),
    }));
    return role;
  },

  deleteRole: async (id) => {
    await invoke('delete_role', { id });
    set((s) => ({
      roles: s.roles.filter((role) => role.id !== id),
      rolesMeta: mutateRolesMeta(s.rolesMeta),
    }));
  },

  searchMarketplace: async (query) => {
    const seq = ++marketplaceSearchSeq;
    set({ marketplaceLoading: true, marketplaceRoles: [] });
    try {
      const marketplaceRoles = await invoke<MarketplaceRole[]>('search_role_marketplace', {
        sourceId: get().selectedMarketplaceSource,
        query,
      });
      if (seq === marketplaceSearchSeq) {
        set({ marketplaceRoles, marketplaceLoading: false });
      }
    } catch (e) {
      console.error('[roleStore] searchMarketplace failed:', e);
      if (seq === marketplaceSearchSeq) {
        set({ marketplaceLoading: false });
      }
    }
  },

  installRole: async (sourceKind, sourceRef) => {
    const role = await invoke<Role>('install_role', { sourceKind, sourceRef });
    set({
      roles: [role, ...get().roles],
      rolesMeta: mutateRolesMeta(get().rolesMeta),
      marketplaceRoles: get().marketplaceRoles.map((item) =>
        item.source_ref === sourceRef ? { ...item, installed: true } : item,
      ),
    });
    return role;
  },
}));
