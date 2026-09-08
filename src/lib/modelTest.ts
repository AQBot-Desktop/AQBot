import { Channel } from '@tauri-apps/api/core';
import { invoke } from '@/lib/invoke';
import type {
  Model,
  ModelTestConfig,
  ModelTestKind,
  ModelTestProgressEvent,
  ModelTestResult,
  ProviderType,
  ProviderConfig,
  AppSettings,
} from '@/types';

export const MODEL_TEST_MAX_PROMPT_CHARS = 2000;

/** Only settings that affect the native request invalidate a measurement. */
export function modelTestFingerprint(provider: ProviderConfig | undefined, settings: AppSettings): string {
  return JSON.stringify({
    provider: provider && {
      id: provider.id, type: provider.provider_type, host: provider.api_host,
      path: provider.api_path, region: provider.aws_region, headers: provider.custom_headers,
      proxy: provider.proxy_config,
      keys: provider.keys.map((key) => [key.id, key.enabled, key.key_encrypted, key.rotation_index]),
      models: provider.models.map((model) => [model.model_id, model.model_type,
        model.param_overrides, model.max_output_tokens, model.capabilities]),
    },
    prompt: settings.model_test_prompt,
    proxy: [settings.proxy_type, settings.proxy_address, settings.proxy_port],
    defaults: [settings.default_temperature, settings.default_top_p, settings.default_max_tokens],
  });
}

export function pendingModelTestResult(providerId: string, modelId: string, testId: string): ModelTestResult {
  return {
    test_id: testId, provider_id: providerId, model_id: modelId, status: 'cancelled',
    first_text_ms: null, total_ms: null, checked_at: Math.floor(Date.now() / 1000),
    response_preview: null, error_code: null, error_detail: null,
  };
}

export function normalizeModelTestPrompt(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;
  if ([...trimmed].length > MODEL_TEST_MAX_PROMPT_CHARS) {
    throw new Error('prompt_too_long');
  }
  return trimmed;
}

export function adapterSupportsKind(
  config: ModelTestConfig | null,
  providerType: ProviderType,
  kind: ModelTestKind,
): boolean {
  const kinds = config?.adapter_kinds.find((item) => item.provider_type === providerType)?.kinds;
  return kinds?.includes(kind) ?? false;
}

export function modelTestKind(model: Model): ModelTestKind | null {
  if (model.model_type === 'Chat') return 'chat';
  if (model.model_type === 'Embedding') return 'embedding';
  if (model.model_type === 'Rerank') return 'rerank';
  return null;
}

export async function getModelTestConfig(): Promise<ModelTestConfig> {
  return invoke<ModelTestConfig>('get_model_test_config');
}

export async function cancelModelTest(testId: string): Promise<void> {
  await invoke('cancel_model_test', { testId });
}

export async function runModelTest(input: {
  testId: string;
  providerId: string;
  modelId: string;
  prompt: string | null;
  thinkingLevel: string | null;
  onEvent: (event: ModelTestProgressEvent) => void;
}): Promise<ModelTestResult> {
  const onEvent = new Channel<ModelTestProgressEvent>();
  onEvent.onmessage = input.onEvent;
  return invoke<ModelTestResult>('test_model', {
    testId: input.testId,
    providerId: input.providerId,
    modelId: input.modelId,
    prompt: input.prompt,
    thinkingLevel: input.thinkingLevel,
    onEvent,
  });
}
