import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type {
  DrawingEditInput,
  DrawingGenerateInput,
  DrawingGeneration,
  DrawingImage,
  DrawingMaskEditInput,
  DrawingStoredFile,
} from '@/types';

interface DrawingState {
  generations: DrawingGeneration[];
  references: DrawingStoredFile[];
  loading: boolean;
  submitting: boolean;
  error: string | null;
  editSourceImage: DrawingImage | null;
  loadHistory: (cursor?: string) => Promise<void>;
  uploadReferenceImage: (file: File) => Promise<DrawingStoredFile>;
  generateImages: (input: DrawingGenerateInput) => Promise<DrawingGeneration>;
  editImage: (input: DrawingEditInput) => Promise<DrawingGeneration>;
  editImageWithMask: (input: DrawingMaskEditInput) => Promise<DrawingGeneration>;
  retryGeneration: (generation: DrawingGeneration) => Promise<DrawingGeneration>;
  deleteGeneration: (id: string) => Promise<void>;
  selectImageForEdit: (image: DrawingImage | null) => void;
  removeReference: (id: string) => void;
  clearReferences: () => void;
  clearError: () => void;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.readAsDataURL(file);
  });
}

function prependOrReplace(
  generations: DrawingGeneration[],
  next: DrawingGeneration,
): DrawingGeneration[] {
  const existing = generations.findIndex((item) => item.id === next.id);
  if (existing === -1) return [next, ...generations];
  return generations.map((item) => (item.id === next.id ? next : item));
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
  generations: [],
  references: [],
  loading: false,
  submitting: false,
  error: null,
  editSourceImage: null,

  loadHistory: async (cursor) => {
    set({ loading: true });
    try {
      const generations = await invoke<DrawingGeneration[]>('list_drawing_generations', {
        limit: 30,
        cursor,
      });
      set({ generations, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: String(e) });
      throw e;
    }
  },

  uploadReferenceImage: async (file) => {
    if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(file.type)) {
      throw new Error('Only PNG, JPEG, and WebP images are supported');
    }
    if (file.size > 50 * 1024 * 1024) {
      throw new Error('Image must be smaller than 50MB');
    }
    if (get().references.length >= 16) {
      throw new Error('Reference image count must not exceed 16');
    }
    const data = await fileToBase64(file);
    const stored = await invoke<DrawingStoredFile>('upload_drawing_reference', {
      input: {
        data,
        file_name: file.name,
        mime_type: file.type || 'image/png',
      },
    });
    set((s) => ({ references: [...s.references, stored], error: null }));
    return stored;
  },

  generateImages: async (input) => {
    set({ submitting: true, error: null });
    try {
      const generation = await invoke<DrawingGeneration>('generate_drawing_images', { input });
      set((s) => ({
        generations: prependOrReplace(s.generations, generation),
        submitting: false,
        editSourceImage: null,
      }));
      return generation;
    } catch (e) {
      set({ submitting: false, error: String(e) });
      await get().loadHistory().catch(() => {});
      throw e;
    }
  },

  editImage: async (input) => {
    set({ submitting: true, error: null });
    try {
      const generation = await invoke<DrawingGeneration>('edit_drawing_image', { input });
      set((s) => ({
        generations: prependOrReplace(s.generations, generation),
        submitting: false,
        editSourceImage: null,
      }));
      return generation;
    } catch (e) {
      set({ submitting: false, error: String(e) });
      await get().loadHistory().catch(() => {});
      throw e;
    }
  },

  editImageWithMask: async (input) => {
    set({ submitting: true, error: null });
    try {
      const generation = await invoke<DrawingGeneration>('edit_drawing_image_with_mask', { input });
      set((s) => ({
        generations: prependOrReplace(s.generations, generation),
        submitting: false,
        editSourceImage: null,
      }));
      return generation;
    } catch (e) {
      set({ submitting: false, error: String(e) });
      await get().loadHistory().catch(() => {});
      throw e;
    }
  },

  retryGeneration: async (generation) => {
    const params = JSON.parse(generation.parameters_json || '{}');
    if (generation.action === 'edit' && params.source_image_id) {
      return get().editImage(params);
    }
    if (generation.action === 'mask_edit' && params.source_image_id && params.mask_file_id) {
      return get().editImageWithMask(params);
    }
    return get().generateImages(params);
  },

  deleteGeneration: async (id) => {
    await invoke('delete_drawing_generation', { id });
    set((s) => ({ generations: s.generations.filter((item) => item.id !== id) }));
  },

  selectImageForEdit: (image) => set({ editSourceImage: image }),
  removeReference: (id) => set((s) => ({ references: s.references.filter((item) => item.id !== id) })),
  clearReferences: () => set({ references: [] }),
  clearError: () => set({ error: null }),
}));
