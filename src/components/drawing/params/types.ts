import type { DrawingModelId, DrawingSettings, ProviderConfig } from '@/types';

export type DrawingParamFieldType =
  | 'select'
  | 'number'
  | 'text'
  | 'compression'
  | 'referenceUploader'
  | 'providerSelect'
  | 'modelSelect';

export type DrawingParamGroupId = 'basic' | 'advanced';
export type DrawingParamSettingKey = keyof DrawingSettings;
export type DrawingParamOptionValue = string | number;
export type DrawingTranslate = (key: string, fallback: string) => string;

export interface DrawingParamOption {
  labelKey?: string;
  fallbackLabel: string;
  value: DrawingParamOptionValue;
}

export interface DrawingParamRenderContext {
  settings: DrawingSettings;
  providers: ProviderConfig[];
  modelOptions: DrawingParamOption[];
  providerOptions: DrawingParamOption[];
  t: DrawingTranslate;
}

export type DrawingParamOptionSource =
  | readonly DrawingParamOption[]
  | ((context: DrawingParamRenderContext) => readonly DrawingParamOption[]);

export interface DrawingParamField {
  id: string;
  key?: DrawingParamSettingKey;
  type: DrawingParamFieldType;
  labelKey: string;
  fallbackLabel: string;
  placeholder?: string;
  hintKey?: string;
  fallbackHint?: string;
  min?: number;
  max?: number;
  defaultValue?: number;
  options?: DrawingParamOptionSource;
  visibleWhen?: (context: DrawingParamRenderContext) => boolean;
  normalizeOnChange?: (
    value: unknown,
    context: DrawingParamRenderContext,
  ) => Partial<DrawingSettings>;
}

export interface DrawingParamGroup {
  id: DrawingParamGroupId;
  fields: readonly DrawingParamField[];
}

export interface DrawingParamConfig {
  id: string;
  modelIds: readonly DrawingModelId[];
  groups: readonly DrawingParamGroup[];
  normalizeSettings?: (settings: DrawingSettings) => DrawingSettings;
}
