import { act, render, renderHook, screen } from '@testing-library/react';
import { App as AntdApp, Modal } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDeepLinkPayload } from '@/lib/providerDeepLink';
import { useUIStore } from '@/stores';
import {
  ProviderDeepLinkConfirmModal,
  submitProviderDeepLinkImport,
  useProviderDeepLinkDialogState,
} from '../useProviderDeepLink';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const payload: ProviderDeepLinkPayload = {
  name: 'Example AI',
  baseurl: 'https://api.example.com',
  apikey: 'sk-example',
  type: 'openai',
};

describe('useProviderDeepLinkDialogState', () => {
  beforeEach(() => {
    act(() => {
      useUIStore.setState({
        activePage: 'chat',
        previousPage: 'chat',
        settingsSection: 'general',
        selectedProviderId: null,
      });
    });
  });

  it('queues import and navigates without opening while providers settings is hidden', () => {
    const { result } = renderHook(() => useProviderDeepLinkDialogState(false));

    act(() => {
      result.current.queue(payload);
    });

    expect(useUIStore.getState().activePage).toBe('settings');
    expect(useUIStore.getState().settingsSection).toBe('providers');
    expect(result.current.pending).toEqual(payload);
    expect(result.current.open).toBe(false);
  });

  it('opens the dialog only after providers settings becomes visible', () => {
    const { result, rerender } = renderHook(
      ({ visible }: { visible: boolean }) => useProviderDeepLinkDialogState(visible),
      { initialProps: { visible: false } },
    );

    act(() => {
      result.current.queue(payload);
    });
    expect(result.current.open).toBe(false);

    rerender({ visible: true });
    expect(result.current.open).toBe(true);
    expect(result.current.pending).toEqual(payload);
  });

  it('keeps pending payload so a later Modal.destroyAll cannot drop the import', () => {
    const { result, rerender } = renderHook(
      ({ visible }: { visible: boolean }) => useProviderDeepLinkDialogState(visible),
      { initialProps: { visible: false } },
    );

    act(() => {
      result.current.queue(payload);
    });

    Modal.destroyAll();

    rerender({ visible: true });
    expect(result.current.pending).toEqual(payload);
    expect(result.current.open).toBe(true);
  });

  it('opens immediately when providers settings is already visible', () => {
    act(() => {
      useUIStore.setState({ activePage: 'settings', settingsSection: 'providers' });
    });
    const { result } = renderHook(() => useProviderDeepLinkDialogState(true));

    act(() => {
      result.current.queue(payload);
    });

    expect(result.current.open).toBe(true);
  });
});

describe('submitProviderDeepLinkImport', () => {
  it('imports after user confirmation and selects the created provider', async () => {
    const importProvider = vi.fn().mockResolvedValue({
      provider_id: 'provider-1',
      provider_name: 'Example AI',
      created_provider: true,
      added_key: true,
      reused_key: false,
    });
    const fetchProviders = vi.fn().mockResolvedValue(undefined);
    const setSelectedProviderId = vi.fn();
    const messageSuccess = vi.fn();

    await submitProviderDeepLinkImport(payload, {
      message: { success: messageSuccess, error: vi.fn() },
      setSelectedProviderId,
      importProvider,
      fetchProviders,
      t: (key) => key,
    });

    expect(importProvider).toHaveBeenCalledWith(payload);
    expect(fetchProviders).toHaveBeenCalledTimes(1);
    expect(setSelectedProviderId).toHaveBeenCalledWith('provider-1');
    expect(messageSuccess).toHaveBeenCalledWith('settings.deepLinkProviderCreated');
  });

  it('reports reused key imports without adding duplicate keys', async () => {
    const messageSuccess = vi.fn();

    await submitProviderDeepLinkImport(payload, {
      message: { success: messageSuccess, error: vi.fn() },
      setSelectedProviderId: vi.fn(),
      importProvider: vi.fn().mockResolvedValue({
        provider_id: 'provider-1',
        provider_name: 'Example AI',
        created_provider: false,
        added_key: false,
        reused_key: true,
      }),
      fetchProviders: vi.fn().mockResolvedValue(undefined),
      t: (key) => key,
    });

    expect(messageSuccess).toHaveBeenCalledWith('settings.deepLinkProviderReusedKey');
  });
});

describe('ProviderDeepLinkConfirmModal', () => {
  it('does not show confirm copy while closed', () => {
    render(
      <AntdApp>
        <ProviderDeepLinkConfirmModal
          payload={payload}
          open={false}
          message={{ success: vi.fn(), error: vi.fn() }}
          onClear={vi.fn()}
        />
      </AntdApp>,
    );

    expect(screen.queryByText('settings.deepLinkProviderConfirmTitle')).not.toBeInTheDocument();
  });

  it('still shows confirm copy after Modal.destroyAll if open stays true', async () => {
    render(
      <AntdApp>
        <ProviderDeepLinkConfirmModal
          payload={payload}
          open
          message={{ success: vi.fn(), error: vi.fn() }}
          onClear={vi.fn()}
        />
      </AntdApp>,
    );

    expect(await screen.findByText('settings.deepLinkProviderConfirmTitle')).toBeInTheDocument();
    act(() => {
      Modal.destroyAll();
    });
    expect(screen.getByText('settings.deepLinkProviderConfirmTitle')).toBeInTheDocument();
  });
});
