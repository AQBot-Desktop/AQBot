import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@/types';

const storeState = {
  session: {
    selection_id: 'selection',
    input_kind: 'text' as 'text' | 'screenshot',
    tools: [],
    theme: 'light',
    language: 'en-US',
  },
  pendingRequest: null as null | { input: { kind: string } },
  run: null as null | { status: string; model_target?: { provider_id: string; model_id: string } },
  busy: false,
  selectedModelTarget: null as null | { provider_id: string; model_id: string },
  selectModelTarget: vi.fn(),
};

const { ensureProvidersLoaded, providerState } = vi.hoisted(() => {
  const ensureProvidersLoaded = vi.fn(async () => {});
  return {
    ensureProvidersLoaded,
    providerState: {
      providers: [] as ProviderConfig[],
      loading: false,
      error: null as string | null,
      ensureProvidersLoaded,
    },
  };
});

vi.mock('@/stores/selectionToolbarStore', () => ({
  useSelectionToolbarStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@/stores/providerStore', () => ({
  useProviderStore: (selector: (state: typeof providerState) => unknown) => selector(providerState),
}));

vi.mock('@/stores', () => ({
  useProviderStore: (selector: (state: typeof providerState) => unknown) => selector(providerState),
}));

vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => <span data-testid="model-icon" />,
}));

function chatProvider(): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'OpenAI Compatible',
    provider_type: 'openai',
    api_host: 'https://api.example.com',
    api_path: '/v1/chat/completions',
    aws_region: null,
    enabled: true,
    models: [
      {
        provider_id: 'provider-1',
        model_id: 'chat-model',
        name: 'Chat Model',
        model_type: 'Chat',
        capabilities: ['TextChat'],
        context_window: 128000,
        enabled: true,
        param_overrides: null,
      },
      {
        provider_id: 'provider-1',
        model_id: 'vision-model',
        name: 'Vision Model',
        model_type: 'Chat',
        capabilities: ['TextChat', 'Vision'],
        context_window: 128000,
        enabled: true,
        param_overrides: null,
      },
      {
        provider_id: 'provider-1',
        model_id: 'embed-model',
        name: 'Embed Model',
        model_type: 'Embedding',
        capabilities: [],
        context_window: null,
        enabled: true,
        param_overrides: null,
      },
    ],
    keys: [],
    proxy_config: null,
    custom_headers: null,
    icon: null,
    builtin_id: null,
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
  };
}

describe('SelectionToolbarModelSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerState.providers = [chatProvider()];
    providerState.loading = false;
    providerState.error = null;
    Object.assign(storeState, {
      pendingRequest: null,
      run: null,
      busy: false,
      selectedModelTarget: null,
      session: {
        selection_id: 'selection',
        input_kind: 'text' as 'text' | 'screenshot',
        tools: [],
        theme: 'light',
        language: 'en-US',
      },
    });
  });

  it('lists enabled chat models and records a temporary selection without sending', async () => {
    const { SelectionToolbarModelSelect } = await import('../SelectionToolbarModelSelect');
    render(<SelectionToolbarModelSelect />);
    expect(ensureProvidersLoaded).toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'settings.selectionToolbar.modelSelect' }));
    expect(await screen.findByText('Chat Model')).toBeInTheDocument();
    expect(screen.getByText('Vision Model')).toBeInTheDocument();
    expect(screen.queryByText('Embed Model')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Chat Model'));
    expect(storeState.selectModelTarget).toHaveBeenCalledWith({
      provider_id: 'provider-1',
      model_id: 'chat-model',
    });
  });

  it('opens the dropdown with the in-window class instead of overflowing the trigger', async () => {
    const { SelectionToolbarModelSelect, SELECTION_TOOLBAR_MODEL_DROPDOWN_CLASS } = await import('../SelectionToolbarModelSelect');
    render(<SelectionToolbarModelSelect />);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'settings.selectionToolbar.modelSelect' }));
    expect(await screen.findByText('Chat Model')).toBeInTheDocument();
    const dropdown = document.querySelector(`.${SELECTION_TOOLBAR_MODEL_DROPDOWN_CLASS}`);
    expect(dropdown).toBeInTheDocument();
  });

  it('keeps only vision chat models for screenshot input', async () => {
    storeState.session = { ...storeState.session, input_kind: 'screenshot' };
    const { SelectionToolbarModelSelect } = await import('../SelectionToolbarModelSelect');
    render(<SelectionToolbarModelSelect />);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'settings.selectionToolbar.modelSelect' }));
    expect(await screen.findByText('Vision Model')).toBeInTheDocument();
    expect(screen.queryByText('Chat Model')).not.toBeInTheDocument();
  });
});
