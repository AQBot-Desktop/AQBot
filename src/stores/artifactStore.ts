import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type { Artifact, CreateArtifactInput, UpdateArtifactInput } from '@/types';

interface ArtifactState {
  // State
  artifacts: Artifact[];
  loading: boolean;
  error: string | null;

  // Actions
  loadArtifacts: (conversationId: string) => Promise<void>;
  createArtifact: (input: CreateArtifactInput) => Promise<Artifact | null>;
  updateArtifact: (id: string, input: UpdateArtifactInput) => Promise<Artifact | null>;
  deleteArtifact: (id: string) => Promise<void>;
  pinArtifact: (id: string, pinned: boolean) => Promise<void>;
  clearArtifacts: () => void;
}

export const useArtifactStore = create<ArtifactState>((set, get) => ({
  artifacts: [],
  loading: false,
  error: null,

  loadArtifacts: async (conversationId) => {
    set({ loading: true, error: null });
    try {
      const artifacts = await invoke<Artifact[]>('list_artifacts', {
        conversation_id: conversationId,
      });
      set({ artifacts, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createArtifact: async (input) => {
    try {
      const artifact = await invoke<Artifact>('create_artifact', input);
      set((s) => ({ artifacts: [...s.artifacts, artifact] }));
      return artifact;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  updateArtifact: async (id, input) => {
    try {
      const updated = await invoke<Artifact>('update_artifact', { id, ...input });
      set((s) => ({
        artifacts: s.artifacts.map((a) => (a.id === id ? updated : a)),
      }));
      return updated;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  deleteArtifact: async (id) => {
    try {
      await invoke('delete_artifact', { id });
      set((s) => ({ artifacts: s.artifacts.filter((a) => a.id !== id) }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  pinArtifact: async (id, pinned) => {
    const { updateArtifact } = get();
    await updateArtifact(id, { pinned });
  },

  clearArtifacts: () => set({ artifacts: [], error: null }),
}));
