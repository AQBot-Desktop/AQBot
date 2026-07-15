import { App } from 'antd';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@/types';
import { DefaultModelSettings } from '../DefaultModelSettings';

const mocks = vi.hoisted(() => ({
  ensureProvidersLoaded: vi.fn(),
  saveSettings: vi.fn(),
}));

let settings: Partial<AppSettings>;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/shared/ModelSelect', () => ({
  ModelSelect: () => <div data-testid="model-select" />,
  parseModelValue: vi.fn(),
}));

vi.mock('@/stores', () => ({
  useProviderStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ensureProvidersLoaded: mocks.ensureProvidersLoaded,
      providers: [],
    }),
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings,
      saveSettings: mocks.saveSettings,
    }),
}));

describe('DefaultModelSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {
      default_temperature: null,
      default_top_p: null,
      default_max_tokens: 32768,
      default_context_count: null,
      default_provider_id: null,
      default_model_id: null,
      title_summary_temperature: null,
      title_summary_top_p: null,
      title_summary_max_tokens: null,
      title_summary_provider_id: null,
      title_summary_model_id: null,
      title_summary_prompt: null,
      compression_temperature: null,
      compression_top_p: null,
      compression_max_tokens: null,
      compression_provider_id: null,
      compression_model_id: null,
      compression_prompt: null,
    };
  });

  it('keeps default max tokens disabled after it is saved as null', async () => {
    const view = render(
      <App>
        <DefaultModelSettings />
      </App>,
    );

    await userEvent.click(screen.getAllByRole('button')[0]);
    let dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getAllByRole('switch')[2]);

    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ default_max_tokens: null });

    settings = { ...settings, default_max_tokens: null };
    view.rerender(
      <App>
        <DefaultModelSettings />
      </App>,
    );

    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByRole('switch')[2]).toHaveAttribute('aria-checked', 'false');
  });
});
