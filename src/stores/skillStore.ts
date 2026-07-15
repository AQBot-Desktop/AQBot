import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import { isResourceFresh } from '@/lib/resourceState';
import type { EnsureLoadedOptions, ResourceInvalidationReason, ResourceMeta } from '@/lib/resourceState';
import type { Skill, SkillDetail, MarketplaceSkill, SkillUpdateInfo } from '@/types';

const SKILLS_RESOURCE_KEY = 'skills';
let skillsRequest: { revision: number; promise: Promise<void> } | null = null;

function mutateSkillsMeta(meta: ResourceMeta): ResourceMeta {
  const remainsComplete = meta.status === 'ready' && meta.key === SKILLS_RESOURCE_KEY;
  return {
    status: remainsComplete ? 'ready' : 'idle',
    key: remainsComplete ? SKILLS_RESOURCE_KEY : null,
    loadedAt: remainsComplete ? Date.now() : null,
    revision: meta.revision + 1,
  };
}

interface SkillState {
  skills: Skill[];
  marketplaceSkills: MarketplaceSkill[];
  loading: boolean;
  marketplaceLoading: boolean;
  selectedSkill: SkillDetail | null;
  skillsMeta: ResourceMeta;

  ensureSkillsLoaded: (options?: EnsureLoadedOptions) => Promise<void>;
  invalidateSkills: (reason: ResourceInvalidationReason) => void;
  loadSkills: () => Promise<void>;
  getSkill: (name: string, sourcePath?: string) => Promise<void>;
  toggleSkill: (name: string, enabled: boolean) => Promise<void>;
  installSkill: (source: string, target?: string) => Promise<string>;
  uninstallSkill: (name: string, sourcePath?: string) => Promise<void>;
  uninstallSkillGroup: (group: string, source?: string) => Promise<void>;
  openSkillsDir: () => Promise<void>;
  openSkillDir: (path: string) => Promise<void>;
  searchMarketplace: (query: string, source?: string) => Promise<void>;
  checkUpdates: () => Promise<SkillUpdateInfo[]>;
  clearSelectedSkill: () => void;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  marketplaceSkills: [],
  loading: false,
  marketplaceLoading: false,
  selectedSkill: null,
  skillsMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },

  ensureSkillsLoaded: async (options = {}) => {
    const key = SKILLS_RESOURCE_KEY;
    const state = get();
    if (!options.force && isResourceFresh(state.skillsMeta, { ...options, key })) return;
    if (skillsRequest?.revision === state.skillsMeta.revision && !options.force) {
      return skillsRequest.promise;
    }
    if (skillsRequest) {
      await skillsRequest.promise;
      return get().ensureSkillsLoaded(options);
    }

    const revision = state.skillsMeta.revision;
    set((state) => ({
      loading: true,
      skillsMeta: { ...state.skillsMeta, status: 'loading', key },
    }));
    let promise!: Promise<void>;
    promise = (async () => {
      let reloadAfterCompletion = false;
      try {
        const skills = await invoke<Skill[]>('list_skills');
        if (get().skillsMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set({
            skills,
            loading: false,
            skillsMeta: { status: 'ready', key, loadedAt: Date.now(), revision },
          });
        }
      } catch (e) {
        console.error('Failed to load skills:', e);
        if (get().skillsMeta.revision !== revision) {
          reloadAfterCompletion = true;
          set({ loading: false });
        } else {
          set((current) => ({
            loading: false,
            skillsMeta: { ...current.skillsMeta, status: 'error' },
          }));
        }
      } finally {
        skillsRequest = null;
      }
      if (reloadAfterCompletion) await get().ensureSkillsLoaded();
    })();
    skillsRequest = { revision, promise };
    return promise;
  },

  invalidateSkills: (_reason) => set((state) => ({
    skillsMeta: {
      status: 'idle',
      key: null,
      loadedAt: null,
      revision: state.skillsMeta.revision + 1,
    },
  })),

  loadSkills: () => get().ensureSkillsLoaded({ force: true }),

  getSkill: async (name: string, sourcePath?: string) => {
    try {
      const detail = await invoke<SkillDetail>('get_skill', { name, sourcePath: sourcePath ?? null });
      set({ selectedSkill: detail });
    } catch (e) {
      console.error('Failed to get skill:', e);
    }
  },

  toggleSkill: async (name: string, enabled: boolean) => {
    set((state) => ({
      skills: state.skills.map(s =>
        s.name === name ? { ...s, enabled } : s
      ),
      skillsMeta: mutateSkillsMeta(state.skillsMeta),
    }));
    try {
      await invoke('toggle_skill', { name, enabled });
      set((state) => ({
        skills: state.skills.map(s =>
          s.name === name ? { ...s, enabled } : s
        ),
        skillsMeta: mutateSkillsMeta(state.skillsMeta),
      }));
    } catch (e) {
      console.error('Failed to toggle skill:', e);
      set((state) => ({
        skills: state.skills.map(s =>
          s.name === name ? { ...s, enabled: !enabled } : s
        ),
        skillsMeta: mutateSkillsMeta(state.skillsMeta),
      }));
    }
  },

  installSkill: async (source: string, target?: string) => {
    const name = await invoke<string>('install_skill', { source, target: target ?? null });
    await get().loadSkills();
    // Mark matching marketplace skill as installed
    set({
      marketplaceSkills: get().marketplaceSkills.map(s =>
        s.repo === source ? { ...s, installed: true } : s
      ),
    });
    return name;
  },

  uninstallSkill: async (name: string, sourcePath?: string) => {
    await invoke('uninstall_skill', { name, sourcePath: sourcePath ?? null });
    set((state) => ({
      skills: state.skills.filter(s => (sourcePath ? s.sourcePath !== sourcePath : s.name !== name)),
      skillsMeta: mutateSkillsMeta(state.skillsMeta),
    }));
  },

  uninstallSkillGroup: async (group: string, source?: string) => {
    await invoke('uninstall_skill_group', { group, source: source ?? null });
    set((state) => ({
      skills: state.skills.filter(s => s.group !== group || (source && s.source !== source)),
      skillsMeta: mutateSkillsMeta(state.skillsMeta),
    }));
  },

  openSkillsDir: async () => {
    await invoke('open_skills_dir');
  },

  openSkillDir: async (path: string) => {
    await invoke('open_skill_dir', { path });
  },

  searchMarketplace: async (query: string, source?: string) => {
    set({ marketplaceLoading: true, marketplaceSkills: [] });
    try {
      const results = await invoke<MarketplaceSkill[]>('search_marketplace', { query, source: source ?? null });
      set({ marketplaceSkills: results, marketplaceLoading: false });
    } catch (e) {
      console.error('Failed to search marketplace:', e);
      set({ marketplaceLoading: false });
    }
  },

  checkUpdates: async () => {
    try {
      const updates = await invoke<SkillUpdateInfo[]>('check_skill_updates');
      return updates;
    } catch (e) {
      console.error('Failed to check updates:', e);
      return [];
    }
  },

  clearSelectedSkill: () => set({ selectedSkill: null }),
}));
