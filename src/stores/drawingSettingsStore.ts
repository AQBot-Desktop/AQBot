import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DRAWING_MODELS,
  DRAWING_SIZE_OPTIONS,
  isDrawingOutputCompressionSupported,
  isDrawingTransparentBackgroundSupported,
} from '@/lib/drawingModels';
import type {
  DrawingBackground,
  DrawingModelId,
  DrawingOutputFormat,
  DrawingQuality,
  DrawingSettings,
} from '@/types';

const DRAWING_SETTINGS_STORAGE_KEY = 'aqbot_drawing_settings';
const MIN_BATCH_COUNT = 1;
const MAX_BATCH_COUNT = 10;
const MIN_OUTPUT_COMPRESSION = 0;
const MAX_OUTPUT_COMPRESSION = 100;

const DRAWING_MODEL_IDS = new Set<DrawingModelId>(DRAWING_MODELS.map((model) => model.id));
const DRAWING_QUALITIES = new Set<DrawingQuality>(['auto', 'low', 'medium', 'high']);
const DRAWING_OUTPUT_FORMATS = new Set<DrawingOutputFormat>(['png', 'jpeg', 'webp']);
const DRAWING_BACKGROUNDS = new Set<DrawingBackground>(['auto', 'opaque', 'transparent']);

export const DEFAULT_DRAWING_SETTINGS: DrawingSettings = {
  providerId: '',
  modelId: 'gpt-image-2',
  size: 'auto',
  quality: 'auto',
  outputFormat: 'png',
  background: 'auto',
  outputCompression: undefined,
  n: 1,
};

interface DrawingSettingsState {
  settings: DrawingSettings;
  setSettings: (settings: DrawingSettings | ((current: DrawingSettings) => DrawingSettings)) => void;
  patchSettings: (settings: Partial<DrawingSettings>) => void;
  resetSettings: () => void;
}

function isDrawingModelId(value: unknown): value is DrawingModelId {
  return typeof value === 'string' && DRAWING_MODEL_IDS.has(value as DrawingModelId);
}

function isDrawingQuality(value: unknown): value is DrawingQuality {
  return typeof value === 'string' && DRAWING_QUALITIES.has(value as DrawingQuality);
}

function isDrawingOutputFormat(value: unknown): value is DrawingOutputFormat {
  return typeof value === 'string' && DRAWING_OUTPUT_FORMATS.has(value as DrawingOutputFormat);
}

function isDrawingBackground(value: unknown): value is DrawingBackground {
  return typeof value === 'string' && DRAWING_BACKGROUNDS.has(value as DrawingBackground);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDrawingSettings(settings: Partial<DrawingSettings> = {}): DrawingSettings {
  const modelId = isDrawingModelId(settings.modelId)
    ? settings.modelId
    : DEFAULT_DRAWING_SETTINGS.modelId;
  const outputFormat = isDrawingOutputFormat(settings.outputFormat)
    ? settings.outputFormat
    : DEFAULT_DRAWING_SETTINGS.outputFormat;
  const rawBackground = isDrawingBackground(settings.background)
    ? settings.background
    : DEFAULT_DRAWING_SETTINGS.background;
  const background = isDrawingTransparentBackgroundSupported(modelId) || rawBackground !== 'transparent'
    ? rawBackground
    : 'auto';
  const outputCompression = typeof settings.outputCompression === 'number'
    ? clampNumber(Math.round(settings.outputCompression), MIN_OUTPUT_COMPRESSION, MAX_OUTPUT_COMPRESSION)
    : undefined;

  return {
    providerId: typeof settings.providerId === 'string'
      ? settings.providerId
      : DEFAULT_DRAWING_SETTINGS.providerId,
    modelId,
    size: typeof settings.size === 'string' && DRAWING_SIZE_OPTIONS.includes(settings.size)
      ? settings.size
      : DEFAULT_DRAWING_SETTINGS.size,
    quality: isDrawingQuality(settings.quality)
      ? settings.quality
      : DEFAULT_DRAWING_SETTINGS.quality,
    outputFormat,
    background,
    outputCompression: isDrawingOutputCompressionSupported(modelId, outputFormat)
      ? outputCompression
      : undefined,
    n: typeof settings.n === 'number'
      ? clampNumber(Math.round(settings.n), MIN_BATCH_COUNT, MAX_BATCH_COUNT)
      : DEFAULT_DRAWING_SETTINGS.n,
  };
}

function readPersistedSettings(persistedState: unknown): Partial<DrawingSettings> {
  if (!persistedState || typeof persistedState !== 'object') return {};
  const state = persistedState as Partial<DrawingSettingsState>;
  return state.settings ?? {};
}

export const useDrawingSettingsStore = create<DrawingSettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_DRAWING_SETTINGS,
      setSettings: (settings) => set((state) => ({
        settings: normalizeDrawingSettings(typeof settings === 'function'
          ? settings(state.settings)
          : settings),
      })),
      patchSettings: (settings) => set((state) => ({
        settings: normalizeDrawingSettings({ ...state.settings, ...settings }),
      })),
      resetSettings: () => set({ settings: DEFAULT_DRAWING_SETTINGS }),
    }),
    {
      name: DRAWING_SETTINGS_STORAGE_KEY,
      partialize: (state) => ({ settings: state.settings }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        settings: normalizeDrawingSettings({
          ...DEFAULT_DRAWING_SETTINGS,
          ...readPersistedSettings(persistedState),
        }),
      }),
    },
  ),
);
