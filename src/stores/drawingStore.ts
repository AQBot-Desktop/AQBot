import { create } from 'zustand';
import { invoke } from '@/lib/invoke';
import type {
  DrawingAction,
  DrawingEditInput,
  DrawingGenerateInput,
  DrawingGeneration,
  DrawingImage,
  DrawingMaskEditInput,
  DrawingReferenceImageMode,
  DrawingStoredFile,
} from '@/types';

const DRAWING_STOPPED_MESSAGE = '主动停止';
const OFFICIAL_IMAGE_PARAM_NAME = 'images';

interface DrawingState {
  generations: DrawingGeneration[];
  references: DrawingStoredFile[];
  loading: boolean;
  submitting: boolean;
  error: string | null;
  editSourceImage: DrawingImage | null;
  editMaskFileId: string | null;
  editMaskFile: DrawingStoredFile | null;
  editPreviewUrl: string | null;
  loadHistory: (cursor?: string) => Promise<void>;
  uploadReferenceImage: (file: File) => Promise<DrawingStoredFile>;
  generateImages: (input: DrawingGenerateInput) => Promise<DrawingGeneration>;
  editImage: (input: DrawingEditInput) => Promise<DrawingGeneration>;
  editImageWithMask: (input: DrawingMaskEditInput) => Promise<DrawingGeneration>;
  retryGeneration: (
    generation: DrawingGeneration,
    referenceImageMode?: DrawingReferenceImageMode,
  ) => Promise<DrawingGeneration>;
  stopGeneration: (id: string) => void;
  deleteGeneration: (id: string, deleteResources?: boolean) => Promise<void>;
  selectImageForEdit: (image: DrawingImage | null, maskFile?: DrawingStoredFile | null, previewUrl?: string | null) => void;
  useImageAsReference: (image: DrawingImage) => DrawingStoredFile;
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

function sortGenerations(generations: DrawingGeneration[]): DrawingGeneration[] {
  return [...generations].sort((a, b) => a.created_at - b.created_at);
}

function appendOrReplace(
  generations: DrawingGeneration[],
  next: DrawingGeneration,
): DrawingGeneration[] {
  const existing = generations.findIndex((item) => item.id === next.id);
  if (existing === -1) return sortGenerations([...generations, next]);
  return sortGenerations(generations.map((item) => (item.id === next.id ? next : item)));
}

function replaceOptimisticGeneration(
  generations: DrawingGeneration[],
  optimisticId: string,
  next: DrawingGeneration,
): DrawingGeneration[] {
  if (!generations.some((item) => item.id === optimisticId)) {
    return appendOrReplace(generations, next);
  }
  return sortGenerations(generations.map((item) => (item.id === optimisticId ? next : item)));
}

function markOptimisticGenerationFailed(
  generations: DrawingGeneration[],
  optimisticId: string,
  error: string,
): DrawingGeneration[] {
  return generations.map((item) => (
    item.id === optimisticId
      ? {
          ...item,
          status: 'failed',
          error_message: error,
          completed_at: Date.now(),
        }
      : item
  ));
}

function markGenerationStopped(
  generations: DrawingGeneration[],
  id: string,
): DrawingGeneration[] {
  return generations.map((item) => (
    item.id === id && item.status === 'running'
      ? {
          ...item,
          status: 'stopped',
          error_message: DRAWING_STOPPED_MESSAGE,
          completed_at: Date.now(),
          images: [],
        }
      : item
  ));
}

function findStoppedGeneration(
  generations: DrawingGeneration[],
  id: string,
): DrawingGeneration | undefined {
  return generations.find((item) => item.id === id && item.status === 'stopped');
}

function createOptimisticGeneration(
  input: DrawingGenerateInput | DrawingEditInput | DrawingMaskEditInput,
  action: DrawingAction,
  context: {
    referenceFiles?: DrawingStoredFile[];
    sourceImages?: DrawingImage[];
    maskFile?: DrawingStoredFile | null;
  } = {},
): DrawingGeneration {
  const now = Date.now();
  const sourceIds = 'source_image_id' in input ? [input.source_image_id] : [];
  const maskFileId = 'mask_file_id' in input ? input.mask_file_id : null;

  return {
    id: `optimistic-${now}-${Math.random().toString(36).slice(2)}`,
    parent_generation_id: null,
    provider_id: input.provider_id,
    key_id: '',
    model_id: input.model_id,
    api_kind: 'image_api',
    action,
    prompt: input.prompt.trim(),
    parameters_json: JSON.stringify(input),
    reference_file_ids_json: JSON.stringify(input.reference_file_ids),
    source_image_ids_json: JSON.stringify(sourceIds),
    mask_file_id: maskFileId,
    status: 'running',
    error_message: null,
    response_id: null,
    usage_json: null,
    created_at: now,
    completed_at: null,
    images: [],
    reference_files: context.referenceFiles ?? [],
    source_images: context.sourceImages ?? [],
    mask_file: context.maskFile ?? null,
  };
}

function referenceFromDrawingImage(image: DrawingImage): DrawingStoredFile {
  return {
    id: image.stored_file_id,
    original_name: image.storage_path.split('/').pop() || `${image.id}.png`,
    mime_type: image.mime_type,
    size_bytes: 0,
    storage_path: image.storage_path,
  };
}

type DrawingRequestInput = DrawingGenerateInput | DrawingEditInput | DrawingMaskEditInput;

function normalizeReferenceImageParamName(value: string): string {
  const trimmed = value.trim();
  return !trimmed || trimmed === 'image' ? OFFICIAL_IMAGE_PARAM_NAME : trimmed;
}

function normalizeDrawingRequestInput<T extends DrawingRequestInput>(input: T): T {
  return {
    ...input,
    reference_image_param_name: normalizeReferenceImageParamName(input.reference_image_param_name),
  };
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
  generations: [],
  references: [],
  loading: false,
  submitting: false,
  error: null,
  editSourceImage: null,
  editMaskFileId: null,
  editMaskFile: null,
  editPreviewUrl: null,

  loadHistory: async (cursor) => {
    set({ loading: true });
    try {
      const generations = await invoke<DrawingGeneration[]>('list_drawing_generations', {
        limit: 30,
        cursor,
      });
      set({ generations: sortGenerations(generations), loading: false, error: null });
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
    set((s) => ({
      references: s.references.some((item) => item.id === stored.id)
        ? s.references
        : [...s.references, stored],
      error: null,
    }));
    return stored;
  },

  generateImages: async (input) => {
    const request = normalizeDrawingRequestInput(input);
    const referenceFiles = get().references.filter((item) => request.reference_file_ids.includes(item.id));
    const optimistic = createOptimisticGeneration(
      request,
      request.reference_file_ids.length > 0 ? 'reference_generate' : 'generate',
      { referenceFiles },
    );
    set((s) => ({
      generations: appendOrReplace(s.generations, optimistic),
      submitting: true,
      error: null,
    }));
    try {
      const generation = await invoke<DrawingGeneration>('generate_drawing_images', { input: request });
      const stopped = findStoppedGeneration(get().generations, optimistic.id);
      if (stopped) return stopped;
      set((s) => ({
        generations: replaceOptimisticGeneration(s.generations, optimistic.id, generation),
        submitting: false,
        editSourceImage: null,
        editMaskFileId: null,
        editMaskFile: null,
        editPreviewUrl: null,
      }));
      return generation;
    } catch (e) {
      const stopped = findStoppedGeneration(get().generations, optimistic.id);
      if (stopped) return stopped;
      set((s) => ({
        generations: markOptimisticGenerationFailed(s.generations, optimistic.id, String(e)),
        submitting: false,
        error: null,
      }));
      throw e;
    }
  },

  editImage: async (input) => {
    const request = normalizeDrawingRequestInput(input);
    const state = get();
    const optimistic = createOptimisticGeneration(request, 'edit', {
      referenceFiles: state.references.filter((item) => request.reference_file_ids.includes(item.id)),
      sourceImages: state.editSourceImage ? [state.editSourceImage] : [],
    });
    set((s) => ({
      generations: appendOrReplace(s.generations, optimistic),
      submitting: true,
      error: null,
    }));
    try {
      const generation = await invoke<DrawingGeneration>('edit_drawing_image', { input: request });
      const stopped = findStoppedGeneration(get().generations, optimistic.id);
      if (stopped) return stopped;
      set((s) => ({
        generations: replaceOptimisticGeneration(s.generations, optimistic.id, generation),
        submitting: false,
        editSourceImage: null,
        editMaskFileId: null,
        editMaskFile: null,
        editPreviewUrl: null,
      }));
      return generation;
    } catch (e) {
      const stopped = findStoppedGeneration(get().generations, optimistic.id);
      if (stopped) return stopped;
      set((s) => ({
        generations: markOptimisticGenerationFailed(s.generations, optimistic.id, String(e)),
        submitting: false,
        error: null,
      }));
      throw e;
    }
  },

  editImageWithMask: async (input) => {
    const request = normalizeDrawingRequestInput(input);
    const state = get();
    const optimistic = createOptimisticGeneration(request, 'mask_edit', {
      referenceFiles: state.references.filter((item) => request.reference_file_ids.includes(item.id)),
      sourceImages: state.editSourceImage ? [state.editSourceImage] : [],
      maskFile: state.editMaskFile,
    });
    set((s) => ({
      generations: appendOrReplace(s.generations, optimistic),
      submitting: true,
      error: null,
    }));
    try {
      const generation = await invoke<DrawingGeneration>('edit_drawing_image_with_mask', { input: request });
      const stopped = findStoppedGeneration(get().generations, optimistic.id);
      if (stopped) return stopped;
      set((s) => ({
        generations: replaceOptimisticGeneration(s.generations, optimistic.id, generation),
        submitting: false,
        editSourceImage: null,
        editMaskFileId: null,
        editMaskFile: null,
        editPreviewUrl: null,
      }));
      return generation;
    } catch (e) {
      const stopped = findStoppedGeneration(get().generations, optimistic.id);
      if (stopped) return stopped;
      set((s) => ({
        generations: markOptimisticGenerationFailed(s.generations, optimistic.id, String(e)),
        submitting: false,
        error: null,
      }));
      throw e;
    }
  },

  retryGeneration: async (generation, referenceImageMode) => {
    const params = {
      ...JSON.parse(generation.parameters_json || '{}'),
      ...(referenceImageMode ? { reference_image_mode: referenceImageMode } : {}),
    };
    if (generation.action === 'edit' && params.source_image_id) {
      return get().editImage(params);
    }
    if (generation.action === 'mask_edit' && params.source_image_id && params.mask_file_id) {
      return get().editImageWithMask(params);
    }
    return get().generateImages(params);
  },

  stopGeneration: (id) => set((s) => ({
    generations: markGenerationStopped(s.generations, id),
    submitting: s.generations.some((item) => item.id === id && item.status === 'running')
      ? false
      : s.submitting,
  })),

  deleteGeneration: async (id, deleteResources = false) => {
    if (id.startsWith('optimistic-')) {
      set((s) => ({ generations: s.generations.filter((item) => item.id !== id) }));
      return;
    }
    await invoke('delete_drawing_generation', { id, deleteResources });
    set((s) => ({ generations: s.generations.filter((item) => item.id !== id) }));
  },

  selectImageForEdit: (image, maskFile = null, previewUrl = null) => set({
    editSourceImage: image,
    editMaskFileId: image ? maskFile?.id ?? null : null,
    editMaskFile: image ? maskFile : null,
    editPreviewUrl: image ? previewUrl : null,
  }),
  useImageAsReference: (image) => {
    const reference = referenceFromDrawingImage(image);
    if (get().references.length >= 16 && !get().references.some((item) => item.id === reference.id)) {
      throw new Error('Reference image count must not exceed 16');
    }
    set((s) => ({
      references: s.references.some((item) => item.id === reference.id)
        ? s.references
        : [...s.references, reference],
      error: null,
    }));
    return reference;
  },
  removeReference: (id) => set((s) => ({ references: s.references.filter((item) => item.id !== id) })),
  clearReferences: () => set({ references: [] }),
  clearError: () => set({ error: null }),
}));
