import { create } from 'zustand';

interface ChatWorkspaceState {
  // State
  selectedArtifactId: string | null;
  comparedMessageIds: [string, string] | null;

  // Actions
  selectArtifact: (id: string | null) => void;
  startCompare: (messageIds: [string, string]) => void;
  clearCompare: () => void;
}

export const useChatWorkspaceStore = create<ChatWorkspaceState>((set) => ({
  selectedArtifactId: null,
  comparedMessageIds: null,

  selectArtifact: (id) => set({ selectedArtifactId: id }),
  startCompare: (messageIds) => set({ comparedMessageIds: messageIds }),
  clearCompare: () => set({ comparedMessageIds: null }),
}));
