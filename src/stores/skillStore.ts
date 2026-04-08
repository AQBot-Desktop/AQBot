import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type { Skill, SkillDetail, MarketplaceSkill, SkillUpdateInfo } from '@/types';

interface SkillState {
  skills: Skill[];
  marketplaceSkills: MarketplaceSkill[];
  loading: boolean;
  marketplaceLoading: boolean;
  selectedSkill: SkillDetail | null;

  loadSkills: () => Promise<void>;
  getSkill: (name: string) => Promise<void>;
  toggleSkill: (name: string, enabled: boolean) => Promise<void>;
  installSkill: (source: string, target?: string) => Promise<string>;
  uninstallSkill: (name: string) => Promise<void>;
  uninstallSkillGroup: (group: string) => Promise<void>;
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

  loadSkills: async () => {
    set({ loading: true });
    try {
      const skills = await invoke<Skill[]>('list_skills');
      set({ skills, loading: false });
    } catch (e) {
      console.error('Failed to load skills:', e);
      set({ loading: false });
    }
  },

  getSkill: async (name: string) => {
    try {
      const detail = await invoke<SkillDetail>('get_skill', { name });
      set({ selectedSkill: detail });
    } catch (e) {
      console.error('Failed to get skill:', e);
    }
  },

  toggleSkill: async (name: string, enabled: boolean) => {
    set({
      skills: get().skills.map(s =>
        s.name === name ? { ...s, enabled } : s
      ),
    });
    try {
      await invoke('toggle_skill', { name, enabled });
    } catch (e) {
      console.error('Failed to toggle skill:', e);
      set({
        skills: get().skills.map(s =>
          s.name === name ? { ...s, enabled: !enabled } : s
        ),
      });
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

  uninstallSkill: async (name: string) => {
    await invoke('uninstall_skill', { name });
    set({ skills: get().skills.filter(s => s.name !== name) });
  },

  uninstallSkillGroup: async (group: string) => {
    await invoke('uninstall_skill_group', { group });
    set({ skills: get().skills.filter(s => s.group !== group) });
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
