import { App } from 'antd';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model, ModelSyncStatus, ProviderConfig, ProviderKey } from '@/types';
import { ProviderDetail } from '../ProviderDetail';

const mocks = vi.hoisted(() => ({
  toggleProvider: vi.fn(),
  updateProvider: vi.fn(),
  updateProviderKey: vi.fn(),
  addBedrockCredentials: vi.fn(),
  updateBedrockCredentials: vi.fn(),
  deleteProvider: vi.fn(),
  addProviderKey: vi.fn(),
  deleteProviderKey: vi.fn(),
  toggleProviderKey: vi.fn(),
  validateProviderKey: vi.fn(),
  toggleModel: vi.fn(),
  updateModelParams: vi.fn(),
  fetchRemoteModels: vi.fn(),
  saveModels: vi.fn(),
  inferModelMetadata: vi.fn(),
  applyModelSync: vi.fn(),
  updateModelMetadata: vi.fn(),
  resetModelMetadata: vi.fn(),
  setSelectedProviderId: vi.fn(),
  invoke: vi.fn(),
  testModel: vi.fn(),
  modelParamSliders: vi.fn(),
}));

vi.setConfig({ testTimeout: 15000 });

function createProviderFixture(): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'OpenAI',
    provider_type: 'openai',
    api_host: 'https://api.openai.com',
    api_path: '/v1/chat/completions',
    aws_region: null,
    enabled: true,
    custom_headers: null,
    icon: null,
    builtin_id: null,
    models: [
      {
        provider_id: 'provider-1',
        model_id: 'gpt-5.4',
        name: 'GPT 5.4',
        group_name: 'gpt-5.4',
        model_type: 'Chat',
        capabilities: ['TextChat'],
        context_window: null,
        enabled: true,
        param_overrides: null,
      },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
  };
}

function createProviderKeyFixture(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id: 'key-1',
    provider_id: 'provider-1',
    key_encrypted: 'enc-1',
    key_prefix: 'sk-old',
    enabled: true,
    last_validated_at: null,
    last_error: null,
    rotation_index: 0,
    created_at: 0,
    ...overrides,
  };
}

function syncCandidate(model: Model, status: ModelSyncStatus) {
  return {
    proposed_model: model,
    status,
    catalog_mode: null,
    inference_source: 'catalog',
    changes: [],
    unsupported_reason: null,
  };
}

let provider: ProviderConfig = createProviderFixture();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

vi.mock('@lobehub/icons', () => ({
  ProviderIcon: () => <div>provider-icon</div>,
  ModelIcon: () => <div>model-icon</div>,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (index: number) => string }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey ? getItemKey(index) : index,
        start: index * 48,
      })),
    getTotalSize: () => count * 48,
    measure: () => {},
    measureElement: () => {},
  }),
}));

vi.mock('../IconPickerModal', () => ({
  default: () => null,
}));

vi.mock('@/components/shared/IconEditor', () => ({
  IconEditor: () => <div>icon-editor</div>,
}));

vi.mock('@/components/shared/DynamicLobeIcon', () => ({
  DynamicLobeIcon: () => <div>dynamic-lobe-icon</div>,
}));

vi.mock('@/components/common/ModelParamSliders', () => ({
  ModelParamSliders: (props: Record<string, unknown>) => {
    mocks.modelParamSliders(props);
    return <div>model-param-sliders</div>;
  },
}));

vi.mock('@/components/common/CopyButton', () => ({
  CopyButton: () => <button type="button">copy-button</button>,
}));

vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <div>smart-provider-icon</div>,
  SmartModelIcon: () => <div>smart-model-icon</div>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@/stores', () => ({
  useProviderStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      providers: [provider],
      toggleProvider: mocks.toggleProvider,
      updateProvider: mocks.updateProvider,
      updateProviderKey: mocks.updateProviderKey,
      addBedrockCredentials: mocks.addBedrockCredentials,
      updateBedrockCredentials: mocks.updateBedrockCredentials,
      deleteProvider: mocks.deleteProvider,
      addProviderKey: mocks.addProviderKey,
      deleteProviderKey: mocks.deleteProviderKey,
      toggleProviderKey: mocks.toggleProviderKey,
      validateProviderKey: mocks.validateProviderKey,
      toggleModel: mocks.toggleModel,
      updateModelParams: mocks.updateModelParams,
      fetchRemoteModels: mocks.fetchRemoteModels,
      saveModels: mocks.saveModels,
      inferModelMetadata: mocks.inferModelMetadata,
      applyModelSync: mocks.applyModelSync,
      updateModelMetadata: mocks.updateModelMetadata,
      resetModelMetadata: mocks.resetModelMetadata,
      testModel: mocks.testModel,
    }),
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      setSelectedProviderId: mocks.setSelectedProviderId,
    }),
}));

describe('ProviderDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    provider = createProviderFixture();
    mocks.saveModels.mockResolvedValue(undefined);
    mocks.applyModelSync.mockResolvedValue(undefined);
    mocks.updateModelMetadata.mockImplementation(async (_providerId, model) => model);
    mocks.resetModelMetadata.mockResolvedValue(provider.models);
    mocks.inferModelMetadata.mockImplementation(async (_providerId, model) =>
      syncCandidate(model, 'remote-only'));
    mocks.fetchRemoteModels.mockResolvedValue({
      candidates: [],
      catalog: {
        configured_source: 'builtin',
        source: 'unavailable',
        freshness: 'unknown',
        matched_context_windows: 0,
        total_chat_models: 0,
        matched_models: 0,
        autofilled_fields: 0,
        inferred_types: 0,
        unsupported_models: 0,
        checked_at: null,
        warning: null,
      },
    });
    mocks.updateProviderKey.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue('sk-test-secret');

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  async function openFirstModelSettings() {
    const modelLabel = screen.getByText('GPT 5.4');
    const row = modelLabel.closest('[data-index]');
    expect(row).not.toBeNull();
    const buttons = within(row as HTMLElement).getAllByRole('button');
    await userEvent.click(buttons[0]);
    return screen.findByRole('dialog');
  }

  async function openBatchEdit(container: HTMLElement, modelNames: string[]) {
    const batchModeButton = container
      .querySelector('.lucide-list-checks')
      ?.closest('button');
    expect(batchModeButton).not.toBeNull();
    await userEvent.click(batchModeButton as HTMLButtonElement);

    for (const modelName of modelNames) {
      const modelRow = screen.getByText(modelName).closest('[data-index]');
      expect(modelRow).not.toBeNull();
      await userEvent.click(within(modelRow as HTMLElement).getByRole('checkbox'));
    }

    const batchEditButton = container
      .querySelector('.lucide-pencil')
      ?.closest('button');
    expect(batchEditButton).not.toBeNull();
    await userEvent.click(batchEditButton as HTMLButtonElement);
    return screen.findByRole('dialog');
  }

  it('shows empty-models guidance with actions when the model list is empty', async () => {
    provider.models = [];

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    expect(
      screen.getByText('模型列表为空。请先配置 API 密钥，然后点击「同步模型」从上游拉取模型。'),
    ).toBeInTheDocument();
    // API Keys card + empty models empty-state both expose "add key"
    expect(screen.getAllByRole('button', { name: 'settings.addKey' }).length).toBeGreaterThanOrEqual(1);
    const syncButtons = screen.getAllByRole('button', { name: 'settings.syncModels' });
    expect(syncButtons.length).toBeGreaterThanOrEqual(1);

    await userEvent.click(syncButtons[syncButtons.length - 1]);
    await waitFor(() => {
      expect(mocks.fetchRemoteModels).toHaveBeenCalledWith('provider-1');
    });
  });

  it('does not fall back to the OpenAI host for an empty New API provider', async () => {
    provider = {
      ...createProviderFixture(),
      builtin_id: 'newapi',
      name: 'New API',
      api_host: '',
      api_path: null,
      enabled: false,
      models: [],
      keys: [],
    };

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    expect(screen.getByPlaceholderText('settings.newApiHostPlaceholder')).toBeInTheDocument();
    expect(screen.getByText('settings.newApiHostHelp')).toBeInTheDocument();
    expect(screen.queryByText(/api\.openai\.com/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'settings.resetDefault' }));
    expect(mocks.updateProvider).toHaveBeenCalledWith('provider-1', { api_host: '' });

    const syncButtons = screen.getAllByRole('button', { name: 'settings.syncModels' });
    await userEvent.click(syncButtons[syncButtons.length - 1]);
    expect(mocks.fetchRemoteModels).not.toHaveBeenCalled();
    expect(await screen.findByText('settings.noApiHostError')).toBeInTheDocument();
  });

  it('shows official website link for built-in providers', () => {
    provider.builtin_id = 'openai';

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    expect(screen.getByRole('button', { name: '官网' })).toBeInTheDocument();
  });

  it('hides official website link for custom providers', () => {
    provider.builtin_id = null;

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    expect(screen.queryByRole('button', { name: '官网' })).not.toBeInTheDocument();
  });

  it('shows model sync request preview from the resolved base URL', () => {
    provider.api_host = 'https://api.openai.com';
    provider.api_path = '/v1/chat/completions';

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    expect(screen.getByText('settings.urlPreviewLabelhttps://api.openai.com/v1')).toBeInTheDocument();
    expect(screen.getByText('settings.modelsUrlPreviewLabelhttps://api.openai.com/v1/models')).toBeInTheDocument();
    expect(screen.getByText('settings.urlPreviewLabelhttps://api.openai.com/v1/chat/completions')).toBeInTheDocument();
  });

  it('honors forced base URLs and provider default versions in request previews', () => {
    provider.api_host = 'https://api.example.com!';
    provider.api_path = '/v1/chat/completions';

    const { unmount } = render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    expect(screen.getByText('settings.urlPreviewLabelhttps://api.example.com')).toBeInTheDocument();
    expect(screen.getByText('settings.modelsUrlPreviewLabelhttps://api.example.com/models')).toBeInTheDocument();

    unmount();
    provider = {
      ...createProviderFixture(),
      provider_type: 'glm',
      api_host: 'https://open.bigmodel.cn/api/paas',
      api_path: '/v4/chat/completions',
    };

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    expect(screen.getByText('settings.urlPreviewLabelhttps://open.bigmodel.cn/api/paas/v4')).toBeInTheDocument();
    expect(screen.getByText('settings.modelsUrlPreviewLabelhttps://open.bigmodel.cn/api/paas/v4/models')).toBeInTheDocument();
    expect(screen.getByText('settings.urlPreviewLabelhttps://open.bigmodel.cn/api/paas/v4/chat/completions')).toBeInTheDocument();
  });

  it('adds a model from the card-level action and derives the default group from the model id', async () => {
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.addModel' }));

    const dialog = await screen.findByRole('dialog');
    const inputs = within(dialog).getAllByRole('textbox');
    await userEvent.type(inputs[0], 'gpt-5.4-think');
    await userEvent.clear(inputs[1]);
    await userEvent.type(inputs[1], 'GPT 5.4 Think');

    await waitFor(() => expect(mocks.inferModelMetadata).toHaveBeenCalled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.addModel' }));

    expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        model_id: 'gpt-5.4-think',
        name: 'GPT 5.4 Think',
        group_name: 'gpt-5.4',
        model_type: 'Chat',
      }),
      [],
    );
  });

  it('previews automatically inferred type, capabilities, and token limits when adding a model', async () => {
    mocks.inferModelMetadata.mockImplementation(async (_providerId, model: Model) => ({
      ...syncCandidate({
        ...model,
        model_type: 'Image',
        capabilities: [],
        context_window: 64_000,
        max_output_tokens: 4_096,
      }, 'remote-only'),
      catalog_mode: 'image_generation',
    }));
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.addModel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getAllByRole('textbox')[0], 'gpt-image-1');

    await waitFor(() => {
      expect(within(dialog).getAllByText('settings.modelType.Image')).toHaveLength(2);
      expect(
        within(dialog).getByLabelText('settings.contextWindow'),
      ).toHaveTextContent('64K');
      expect(
        within(dialog).getByLabelText('settings.modelMaxOutputTokens'),
      ).toHaveTextContent('4.1K');
    });
    expect(
      within(dialog).queryByText(/settings\.modelMaxOutputTokens:/),
    ).not.toBeInTheDocument();
  });

  it('still adds a model when catalog inference reports an unknown mode', async () => {
    mocks.inferModelMetadata.mockImplementation(async (_providerId, model: Model) => ({
      ...syncCandidate(model, 'remote-only'),
      catalog_mode: 'search',
      unsupported_reason: 'LiteLLM catalog mode is not supported by AQBot: search',
    }));
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.addModel' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getAllByRole('textbox')[0], 'web-search-model');
    await waitFor(() => expect(mocks.inferModelMetadata).toHaveBeenCalled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.addModel' }));

    expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        model_id: 'web-search-model',
        model_type: 'Chat',
      }),
      [],
    );
  });

  it('prefills the current group when adding a model from a group header', async () => {
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.addModelToGroup' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByDisplayValue('gpt-5.4')).toBeInTheDocument();
  });

  it('toggles the decrypted key inline between revealed and hidden states', async () => {
    provider.keys = [createProviderKeyFixture()];

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.viewKey' }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('get_decrypted_provider_key', { keyId: 'key-1' });
    });

    expect(screen.getByText('sk-test-secret')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'settings.viewKey' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'common.hide' }));

    expect(screen.queryByText('sk-test-secret')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.viewKey' })).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('uses plain text input when adding a key', async () => {
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.addKey' }));

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByRole('textbox');
    await userEvent.type(input, 'sk-added-secret');
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(mocks.addProviderKey).toHaveBeenCalledWith('provider-1', 'sk-added-secret');
    });
  });

  it('shows Region instead of API host and submits temporary Bedrock credentials', async () => {
    provider = {
      ...createProviderFixture(),
      name: 'AWS Bedrock',
      provider_type: 'bedrock',
      api_host: '',
      api_path: null,
      aws_region: 'us-west-2',
      keys: [],
    };
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    expect(screen.getAllByText('settings.awsRegion').length).toBeGreaterThan(0);
    expect(screen.queryByText('Base URL')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.customHeaders')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'settings.addAwsCredentials' }));
    const dialog = await screen.findByRole('dialog');
    const inputs = dialog.querySelectorAll('input');
    expect(inputs).toHaveLength(3);
    await userEvent.type(inputs[0], 'AKIA123456789');
    await userEvent.type(inputs[1], 'secret-value');
    await userEvent.type(inputs[2], 'session-value');
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => {
      expect(mocks.addBedrockCredentials).toHaveBeenCalledWith('provider-1', {
        access_key_id: 'AKIA123456789',
        secret_access_key: 'secret-value',
        session_token: 'session-value',
      });
    });
  });

  it('loads Bedrock credentials with the dedicated IPC command when editing', async () => {
    provider = {
      ...createProviderFixture(),
      provider_type: 'bedrock',
      api_host: '',
      api_path: null,
      aws_region: 'us-east-1',
      keys: [createProviderKeyFixture({ key_prefix: 'AKIA1234…' })],
    };
    mocks.invoke.mockResolvedValue({
      access_key_id: 'AKIA123456789',
      secret_access_key: 'secret-value',
      session_token: null,
    });
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    expect(screen.getByText('AKIA1234…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings.viewKey' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'settings.editKey' }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('get_decrypted_bedrock_credentials', {
        keyId: 'key-1',
      });
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByRole('textbox')[0]).toHaveValue('AKIA123456789');
  });

  it('uses plain text input when editing a key and saves the updated value', async () => {
    provider.keys = [createProviderKeyFixture()];

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.editKey' }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('get_decrypted_provider_key', { keyId: 'key-1' });
    });

    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByRole('textbox');
    expect(input).toHaveValue('sk-test-secret');
    await userEvent.clear(input);
    await userEvent.type(input, 'sk-updated-secret');

    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.saveKey' }));

    await waitFor(() => {
      expect(mocks.updateProviderKey).toHaveBeenCalledWith('key-1', 'sk-updated-secret');
    });
  });

  it('saves model extra_body as a JSON object override', async () => {
    provider.models[0].param_overrides = {
      temperature: 0.1,
      extra_body: { enable_thinking: true },
    };

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openFirstModelSettings();
    const extraBodyInput = within(dialog).getByLabelText('settings.extraBody');
    expect(extraBodyInput).toHaveValue('{\n  "enable_thinking": true\n}');

    fireEvent.change(extraBodyInput, {
      target: { value: '{"thinking":{"type":"enabled"},"include_reasoning":true}' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          model_id: 'gpt-5.4',
          param_overrides: expect.objectContaining({
            temperature: 0.1,
            extra_body: {
              thinking: { type: 'enabled' },
              include_reasoning: true,
            },
          }),
        }),
        [],
      );
    });
  });

  it('rejects invalid model extra_body JSON before saving', async () => {
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openFirstModelSettings();
    const extraBodyInput = within(dialog).getByLabelText('settings.extraBody');

    fireEvent.change(extraBodyInput, { target: { value: '["enable_thinking"]' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));

    expect(mocks.updateModelMetadata).not.toHaveBeenCalled();
    expect(within(dialog).getByText('settings.extraBodyObjectError')).toBeInTheDocument();
  });

  it('rejects reserved model extra_body fields before saving', async () => {
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openFirstModelSettings();
    const extraBodyInput = within(dialog).getByLabelText('settings.extraBody');

    fireEvent.change(extraBodyInput, { target: { value: '{"model":"other","enable_thinking":true}' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));

    expect(mocks.updateModelMetadata).not.toHaveBeenCalled();
    expect(within(dialog).getByText('settings.extraBodyReservedError')).toBeInTheDocument();
  });

  it('keeps missing model parameter overrides disabled in model settings', async () => {
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await openFirstModelSettings();

    const calls = mocks.modelParamSliders.mock.calls;
    const props = calls[calls.length - 1]?.[0] as { values?: unknown } | undefined;
    expect(props?.values).toEqual({
      temperature: null,
      topP: null,
      maxTokens: null,
      frequencyPenalty: null,
    });
  });

  it('clears an existing context window from model settings', async () => {
    provider.models[0].context_window = 16_000;
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openFirstModelSettings();
    const contextSwitch = within(dialog).getByRole('switch', {
      name: 'settings.contextWindow',
    });
    expect(contextSwitch).toBeChecked();
    await userEvent.click(contextSwitch);
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          model_id: 'gpt-5.4',
          context_window: null,
        }),
        expect.arrayContaining(['context_window']),
      );
    });
  });

  it('uses 128K only after enabling an unknown context window', async () => {
    provider.models[0].context_window = null;
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openFirstModelSettings();
    const contextSwitch = within(dialog).getByRole('switch', {
      name: 'settings.contextWindow',
    });
    expect(contextSwitch).not.toBeChecked();
    await userEvent.click(contextSwitch);
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          model_id: 'gpt-5.4',
          context_window: 128_000,
        }),
        expect.arrayContaining(['context_window']),
      );
    });
  });

  it('uses one metadata sync action instead of repeated restore links', async () => {
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openFirstModelSettings();
    expect(within(dialog).queryByText('settings.restoreAutomatic')).not.toBeInTheDocument();
    expect(
      within(dialog).getAllByRole('button', { name: 'settings.syncModelMetadata' }),
    ).toHaveLength(1);
  });

  it('previews metadata differences and saves selected fields with automatic ownership', async () => {
    provider.models[0] = {
      ...provider.models[0],
      context_window: 16_000,
      max_output_tokens: null,
      param_overrides: {
        no_system_role: true,
        reasoning_options: ['high', 'low'],
        reasoning_default: 'high',
      },
      metadata_state: {
        schema_version: 1,
        catalog_key: null,
        catalog_mode: null,
        model_type: 'user',
        capabilities: 'user',
        context_window: 'provider',
        max_output_tokens: 'user',
        no_system_role: 'user',
        omit_sampling_params: 'user',
        reasoning_options: 'user',
      },
    };
    const inferredModel: Model = {
      ...provider.models[0],
      context_window: 32_000,
      max_output_tokens: 8_192,
      param_overrides: {
        ...provider.models[0].param_overrides,
        no_system_role: false,
        reasoning_options: ['low', 'high'],
      },
      metadata_state: {
        schema_version: 2,
        catalog_key: 'gpt-5.4',
        catalog_mode: 'chat',
        model_type: 'catalog',
        capabilities: 'catalog',
        context_window: 'catalog',
        max_output_tokens: 'catalog',
        no_system_role: 'catalog',
        omit_sampling_params: 'default',
        reasoning_options: 'catalog',
      },
    };
    mocks.inferModelMetadata.mockResolvedValue(syncCandidate(inferredModel, 'synced'));

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const settingsDialog = await openFirstModelSettings();
    const contextSwitch = within(settingsDialog).getByRole('switch', {
      name: 'settings.contextWindow',
    });
    await userEvent.click(contextSwitch);
    await userEvent.click(contextSwitch);
    await userEvent.click(
      within(settingsDialog).getByRole('button', { name: 'settings.syncModelMetadata' }),
    );
    const syncHint = await screen.findByText('settings.syncModelMetadataHint');
    const syncDialog = syncHint.closest('[role="dialog"]');
    expect(syncDialog).not.toBeNull();

    expect(mocks.inferModelMetadata).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        model_id: 'gpt-5.4',
        context_window: 128_000,
        metadata_state: expect.objectContaining({ context_window: 'user' }),
      }),
      true,
    );
    expect(
      within(syncDialog as HTMLElement).getByRole('checkbox', {
        name: 'settings.metadataSyncField.context_window',
      }),
    ).toBeChecked();
    expect(
      within(syncDialog as HTMLElement).getByRole('checkbox', {
        name: 'settings.metadataSyncField.max_output_tokens',
      }),
    ).toBeChecked();
    expect(
      within(syncDialog as HTMLElement).getByRole('checkbox', {
        name: 'settings.metadataSyncField.reasoning_options',
      }),
    ).not.toBeChecked();
    expect(
      within(syncDialog as HTMLElement).getByRole('checkbox', {
        name: 'settings.metadataSyncField.omit_sampling_params',
      }),
    ).toBeDisabled();

    await userEvent.click(
      within(syncDialog as HTMLElement).getByRole('checkbox', {
        name: 'settings.metadataSyncField.max_output_tokens',
      }),
    );
    await userEvent.click(
      within(syncDialog as HTMLElement).getByRole('button', { name: 'settings.syncSelectedMetadata' }),
    );

    expect(mocks.updateModelMetadata).not.toHaveBeenCalled();
    expect(
      within(settingsDialog).getByRole('button', { name: 'common.save' }),
    ).toBeInTheDocument();

    await userEvent.click(
      within(settingsDialog).getByRole('button', { name: 'common.save' }),
    );
    await waitFor(() => {
      expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          context_window: 32_000,
          max_output_tokens: null,
          param_overrides: expect.objectContaining({
            no_system_role: false,
            reasoning_options: ['high', 'low'],
            reasoning_default: 'high',
          }),
          metadata_state: expect.objectContaining({
            schema_version: 2,
            catalog_key: 'gpt-5.4',
            catalog_mode: 'chat',
            context_window: 'catalog',
            max_output_tokens: 'user',
            no_system_role: 'catalog',
          }),
        }),
        [],
        expect.arrayContaining(['context_window', 'no_system_role']),
      );
    });
  });

  it('hides chat parameters when editing an image model', async () => {
    provider.models[0] = {
      ...provider.models[0],
      model_type: 'Image',
      capabilities: [],
      context_window: 32_000,
      param_overrides: { temperature: 0.2 },
      image_config: { adapter_id: 'openai_images' },
    };

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openFirstModelSettings();
    expect(within(dialog).getByText('图片协议')).toBeInTheDocument();
    expect(within(dialog).queryByText('settings.modelParams')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('settings.contextWindow')).not.toBeInTheDocument();
    expect(mocks.modelParamSliders).not.toHaveBeenCalled();
  });

  it('preserves persisted chat parameters without validating hidden fields when switching to Image', async () => {
    const persistedOverrides = {
      temperature: 0.2,
      extra_body: { enable_thinking: true },
    };
    provider.models[0] = {
      ...provider.models[0],
      capabilities: ['TextChat', 'Reasoning'],
      context_window: 32_000,
      param_overrides: persistedOverrides,
    };

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openFirstModelSettings();
    fireEvent.change(within(dialog).getByLabelText('settings.extraBody'), {
      target: { value: '["invalid hidden value"]' },
    });
    await userEvent.click(within(dialog).getByText('settings.modelType.Image'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          model_id: 'gpt-5.4',
          model_type: 'Image',
          capabilities: [],
          context_window: 32_000,
          param_overrides: persistedOverrides,
        }),
        expect.arrayContaining(['model_type', 'capabilities']),
      );
    });
  });

  it('hides batch capabilities and chat parameters when every selected model is Image', async () => {
    provider.models[0] = {
      ...provider.models[0],
      model_type: 'Image',
      capabilities: [],
      image_config: { adapter_id: 'openai_images' },
    };

    const { container } = render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openBatchEdit(container, ['GPT 5.4']);
    expect(within(dialog).queryByText('settings.modelAbilities')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('settings.contextWindow')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('settings.modelParams')).not.toBeInTheDocument();
    expect(mocks.modelParamSliders).not.toHaveBeenCalled();
  });

  it('shows and applies chat parameters when image models are converted to Chat in batch', async () => {
    provider.models[0] = {
      ...provider.models[0],
      model_type: 'Image',
      capabilities: [],
      context_window: 16_000,
      param_overrides: { temperature: 0.2 },
    };

    const { container } = render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openBatchEdit(container, ['GPT 5.4']);
    await userEvent.click(within(dialog).getAllByRole('switch')[0]);
    expect(within(dialog).getByText('settings.modelParams')).toBeInTheDocument();

    const sliderCalls = mocks.modelParamSliders.mock.calls;
    const sliderProps = sliderCalls[sliderCalls.length - 1]?.[0] as {
      onChange: (value: { temperature: number }) => void;
    };
    act(() => sliderProps.onChange({ temperature: 0.8 }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.batchApply' }));

    await waitFor(() => {
      expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          model_id: 'gpt-5.4',
          model_type: 'Chat',
          param_overrides: expect.objectContaining({ temperature: 0.8 }),
        }),
        expect.arrayContaining(['model_type', 'capabilities']),
      );
    });
  });

  it('ignores hidden batch chat parameters when mixed models are converted to Image', async () => {
    provider.models = [
      {
        ...provider.models[0],
        name: 'Image Model',
        model_id: 'image-model',
        model_type: 'Image',
        capabilities: [],
        context_window: 16_000,
        param_overrides: { temperature: 0.2 },
      },
      {
        ...provider.models[0],
        name: 'Chat Model',
        model_id: 'chat-model',
        context_window: 32_000,
        param_overrides: { temperature: 0.4 },
      },
    ];

    const { container } = render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openBatchEdit(container, ['Image Model', 'Chat Model']);
    const sliderCalls = mocks.modelParamSliders.mock.calls;
    const sliderProps = sliderCalls[sliderCalls.length - 1]?.[0] as {
      onChange: (value: { temperature: number }) => void;
    };
    act(() => sliderProps.onChange({ temperature: 0.9 }));
    await userEvent.click(within(dialog).getAllByRole('switch')[0]);
    await userEvent.click(within(dialog).getByText('settings.modelType.Image'));

    expect(within(dialog).queryByText('settings.modelParams')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.batchApply' }));

    await waitFor(() => {
      expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          model_id: 'image-model',
          model_type: 'Image',
          capabilities: [],
          context_window: 16_000,
          param_overrides: { temperature: 0.2 },
        }),
        expect.arrayContaining(['model_type', 'capabilities']),
      );
      expect(mocks.updateModelMetadata).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          model_id: 'chat-model',
          model_type: 'Image',
          capabilities: [],
          context_window: 32_000,
          param_overrides: { temperature: 0.4 },
        }),
        expect.arrayContaining(['model_type', 'capabilities']),
      );
    });
  });

  it('applies mixed batch chat parameters only to final non-Image models', async () => {
    provider.models = [
      {
        ...provider.models[0],
        name: 'Image Model',
        model_id: 'image-model',
        model_type: 'Image',
        capabilities: [],
        context_window: 16_000,
        param_overrides: { temperature: 0.2 },
      },
      {
        ...provider.models[0],
        name: 'Chat Model',
        model_id: 'chat-model',
        context_window: 32_000,
        param_overrides: { temperature: 0.4 },
      },
    ];

    const { container } = render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const dialog = await openBatchEdit(container, ['Image Model', 'Chat Model']);
    const sliderCalls = mocks.modelParamSliders.mock.calls;
    const sliderProps = sliderCalls[sliderCalls.length - 1]?.[0] as {
      onChange: (value: { temperature: number }) => void;
    };
    act(() => sliderProps.onChange({ temperature: 0.9 }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.batchApply' }));

    await waitFor(() => {
      expect(mocks.saveModels).toHaveBeenCalledWith(
        'provider-1',
        expect.arrayContaining([
          expect.objectContaining({
            model_id: 'image-model',
            param_overrides: { temperature: 0.2 },
          }),
          expect.objectContaining({
            model_id: 'chat-model',
            param_overrides: expect.objectContaining({ temperature: 0.9 }),
          }),
        ]),
      );
    });
  });

  it('selects every model at once with the batch-mode select-all checkbox', async () => {
    provider.models.push(
      {
        ...provider.models[0],
        model_id: 'claude-model',
        name: 'Claude Model',
        group_name: 'claude',
        enabled: false,
      },
      {
        ...provider.models[0],
        model_id: 'gemini-model',
        name: 'Gemini Model',
        group_name: 'gemini',
        enabled: false,
      },
    );

    const { container } = render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    const batchModeButton = container
      .querySelector('.lucide-list-checks')
      ?.closest('button');
    expect(batchModeButton).not.toBeNull();
    await userEvent.click(batchModeButton as HTMLButtonElement);

    const selectAll = screen.getByRole('checkbox', { name: 'common.selectAll' });
    expect(selectAll).not.toBeChecked();
    await userEvent.click(selectAll);
    expect(selectAll).toBeChecked();

    const enableButton = container.querySelector('.lucide-power')?.closest('button');
    expect(enableButton).not.toBeNull();
    await userEvent.click(enableButton as HTMLButtonElement);

    await waitFor(() => {
      expect(mocks.saveModels).toHaveBeenCalledWith(
        'provider-1',
        provider.models.map((model) => ({ ...model, enabled: true })),
      );
    });

    await userEvent.click(selectAll);
    expect(selectAll).not.toBeChecked();
  });

  it('keeps model sync usable when the online catalog is unavailable', async () => {
    provider.models[0] = {
      ...provider.models[0],
      context_window: 1_048_576,
      max_output_tokens: 32_768,
    };
    mocks.fetchRemoteModels.mockResolvedValue({
      candidates: provider.models.map((model) => syncCandidate(model, 'synced')),
      catalog: {
        configured_source: 'online',
        source: 'unavailable',
        freshness: 'unknown',
        matched_context_windows: 0,
        total_chat_models: 1,
        matched_models: 0,
        autofilled_fields: 0,
        inferred_types: 0,
        unsupported_models: 0,
        checked_at: null,
        warning: 'offline',
      },
    });
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.syncModels' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('settings.modelCatalogWarning')).toBeInTheDocument();
    expect(within(dialog).getByText('settings.modelCatalogSource.unavailable')).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText('settings.contextWindow'),
    ).toHaveTextContent('1.0M');
    const outputLimit = within(dialog).getByLabelText('settings.modelMaxOutputTokens');
    expect(outputLimit).toHaveTextContent('32.8K');
    expect(
      within(dialog).queryByText(/settings\.modelMaxOutputTokens:/),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'settings.applyModelSync' }),
    );

    await waitFor(() => {
      expect(mocks.applyModelSync).toHaveBeenCalledWith('provider-1', provider.models);
    });
  });

  it('keeps existing models after a sync failure and does not show discovery status banner', async () => {
    const existingModels = [...provider.models];
    mocks.fetchRemoteModels.mockRejectedValue(new Error('image discovery offline'));

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.syncModels' }));

    expect((await screen.findAllByText(/image discovery offline/)).length).toBeGreaterThan(0);
    expect(mocks.applyModelSync).not.toHaveBeenCalled();
    expect(mocks.saveModels).not.toHaveBeenCalled();
    expect(provider.models).toEqual(existingModels);
    expect(screen.queryByText(/模型目录已同步|模型目录已过期|modelDiscoveryFresh|modelDiscoveryStale/)).toBeNull();
  });

  it('lets the user import a remote model whose catalog mode is unknown', async () => {
    const supportedLocal = {
      ...provider.models[0],
      model_id: 'local-chat',
      name: 'Local Chat',
    };
    provider.models = [supportedLocal];
    const remoteSearch = {
      ...syncCandidate({
        ...supportedLocal,
        model_id: 'web-search-model',
        name: 'web-search-model',
        model_type: 'Chat' as const,
      }, 'remote-only'),
      catalog_mode: 'search',
    };
    mocks.fetchRemoteModels.mockResolvedValue({
      candidates: [remoteSearch, syncCandidate(supportedLocal, 'local-only')],
      catalog: {
        configured_source: 'builtin',
        source: 'builtin',
        freshness: 'fresh',
        matched_context_windows: 0,
        total_chat_models: 2,
        matched_models: 1,
        autofilled_fields: 0,
        inferred_types: 0,
        unsupported_models: 0,
        checked_at: null,
        warning: null,
      },
    });
    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.syncModels' }));
    const dialog = await screen.findByRole('dialog');
    const remoteCheckbox = within(dialog).getByRole('checkbox', { name: 'web-search-model' });
    expect(remoteCheckbox).not.toBeDisabled();
    expect(remoteCheckbox).not.toBeChecked();
    await userEvent.click(remoteCheckbox);
    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.applyModelSync' }));

    await waitFor(() => {
      expect(mocks.applyModelSync).toHaveBeenCalledWith(
        'provider-1',
        expect.arrayContaining([
          expect.objectContaining({ model_id: 'web-search-model', model_type: 'Chat' }),
          expect.objectContaining({ model_id: 'local-chat' }),
        ]),
      );
    });
  });

  it('syncs remote models without overwriting existing local model settings', async () => {
    provider.models = [
      {
        provider_id: 'provider-1',
        model_id: 'gpt-5.4',
        name: 'Local GPT 5.4',
        group_name: 'local-group',
        model_type: 'Chat',
        capabilities: ['TextChat', 'Reasoning'],
        context_window: 16000,
        enabled: false,
        param_overrides: { temperature: 0.1, top_p: 0.8 },
      },
      {
        provider_id: 'provider-1',
        model_id: 'gpt-5.4-empty',
        name: 'Local GPT 5.4 Empty',
        group_name: 'local-group',
        model_type: 'Chat',
        capabilities: ['TextChat'],
        context_window: null,
        enabled: true,
        param_overrides: null,
      },
      {
        provider_id: 'provider-1',
        model_id: 'legacy-model',
        name: 'Legacy Model',
        group_name: 'legacy',
        model_type: 'Chat',
        capabilities: ['TextChat'],
        context_window: 4000,
        enabled: true,
        param_overrides: null,
      },
    ];

    mocks.fetchRemoteModels.mockResolvedValue({
      candidates: [
        syncCandidate({
          provider_id: 'provider-1',
          model_id: 'gpt-5.4',
          name: 'Local GPT 5.4',
          group_name: 'local-group',
          model_type: 'Chat',
          capabilities: ['TextChat', 'Reasoning'],
          context_window: 16000,
          enabled: false,
          param_overrides: { temperature: 0.1, top_p: 0.8 },
        }, 'synced'),
        syncCandidate({
          provider_id: 'provider-1',
          model_id: 'gpt-5.4-empty',
          name: 'Local GPT 5.4 Empty',
          group_name: 'local-group',
          model_type: 'Chat',
          capabilities: ['TextChat'],
          context_window: 64000,
          enabled: true,
          param_overrides: null,
        }, 'synced'),
        syncCandidate({
          provider_id: 'provider-1',
          model_id: 'gpt-5.4-mini',
          name: 'Remote GPT 5.4 Mini',
          group_name: 'remote-group',
          model_type: 'Chat',
          capabilities: ['TextChat'],
          context_window: 8000,
          enabled: true,
          param_overrides: null,
        }, 'remote-only'),
        syncCandidate(provider.models[2], 'local-only'),
      ],
      catalog: {
        configured_source: 'online',
        source: 'network',
        freshness: 'fresh',
        matched_context_windows: 3,
        total_chat_models: 3,
        matched_models: 3,
        autofilled_fields: 3,
        inferred_types: 0,
        unsupported_models: 0,
        checked_at: 100000,
        warning: null,
      },
    });

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.syncModels' }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/settings\.modelCatalogMatched: 3/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'gpt-5.4' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'gpt-5.4-empty' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'legacy-model' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'gpt-5.4-mini' })).not.toBeChecked();
    expect(within(dialog).getByText('settings.remoteMissing')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'gpt-5.4-mini' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.applyModelSync' }));

    await waitFor(() => {
      expect(mocks.applyModelSync).toHaveBeenCalledWith(
        'provider-1',
        expect.arrayContaining([
          expect.objectContaining({
            model_id: 'gpt-5.4',
            name: 'Local GPT 5.4',
            group_name: 'local-group',
            context_window: 16000,
            enabled: false,
            param_overrides: { temperature: 0.1, top_p: 0.8 },
          }),
          expect.objectContaining({
            model_id: 'gpt-5.4-empty',
            name: 'Local GPT 5.4 Empty',
            group_name: 'local-group',
            context_window: 64000,
          }),
          expect.objectContaining({
            model_id: 'legacy-model',
            name: 'Legacy Model',
            group_name: 'legacy',
          }),
          expect.objectContaining({
            model_id: 'gpt-5.4-mini',
            name: 'Remote GPT 5.4 Mini',
            group_name: 'remote-group',
            context_window: 8000,
          }),
        ]),
      );
    });
  });

  async function openProviderProxyPanel() {
    await userEvent.click(screen.getByText('settings.providerProxy'));
    await screen.findByText('settings.proxyType');
  }

  it('defaults provider proxy type to follow global when proxy_config is null', async () => {
    provider.proxy_config = null;

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await openProviderProxyPanel();

    expect(screen.getByText('settings.proxyFollow')).toBeInTheDocument();
    expect(screen.queryByText('settings.proxyNone')).not.toBeInTheDocument();
  });

  it('saves explicit none when user disables provider proxy', async () => {
    provider.proxy_config = null;

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await openProviderProxyPanel();
    await userEvent.click(screen.getByText('settings.proxyFollow'));
    await userEvent.click(await screen.findByText('settings.proxyNone'));

    expect(mocks.updateProvider).toHaveBeenCalledWith('provider-1', {
      proxy_config: {
        proxy_type: 'none',
        proxy_address: null,
        proxy_port: null,
      },
    });
  });

  it('saves null proxy_type when user chooses follow global', async () => {
    provider.proxy_config = {
      proxy_type: 'none',
      proxy_address: null,
      proxy_port: null,
    };

    render(
      <App>
        <ProviderDetail providerId="provider-1" />
      </App>,
    );

    await openProviderProxyPanel();
    await userEvent.click(screen.getByText('settings.proxyNone'));
    await userEvent.click(await screen.findByText('settings.proxyFollow'));

    expect(mocks.updateProvider).toHaveBeenCalledWith('provider-1', {
      proxy_config: {
        proxy_type: null,
        proxy_address: null,
        proxy_port: null,
      },
    });
  });
});
