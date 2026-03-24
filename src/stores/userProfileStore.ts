import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke, isTauri } from '@/lib/invoke';

export type AvatarType = 'icon' | 'emoji' | 'url' | 'file';

interface UserProfile {
  name: string;
  avatarType: AvatarType;
  avatarValue: string; // emoji char, URL, or relative file path
}

interface UserProfileState {
  profile: UserProfile;
  updateProfile: (partial: Partial<UserProfile>) => void;
  saveAvatarFile: (dataUri: string) => Promise<void>;
}

export const useUserProfileStore = create<UserProfileState>()(
  persist(
    (set, get) => ({
      profile: {
        name: '',
        avatarType: 'icon',
        avatarValue: '',
      },
      updateProfile: (partial) => {
        set({ profile: { ...get().profile, ...partial } });
      },
      saveAvatarFile: async (dataUri: string) => {
        const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
        if (!match) throw new Error('Invalid data URI');
        const [, mimeType, data] = match;
        if (isTauri()) {
          const relativePath = await invoke<string>('save_avatar_file', {
            data,
            mimeType,
          });
          set({
            profile: {
              ...get().profile,
              avatarType: 'file',
              avatarValue: relativePath,
            },
          });
        } else {
          // Browser fallback: store data URI directly
          set({
            profile: {
              ...get().profile,
              avatarType: 'file',
              avatarValue: dataUri,
            },
          });
        }
      },
    }),
    { name: 'aqbot_user_profile' },
  ),
);
