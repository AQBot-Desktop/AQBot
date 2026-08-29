import { App as AntdApp, Descriptions, Modal, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@/lib/invoke';
import {
  getProviderDeepLinkKeyPrefix,
  parseProviderDeepLink,
  type ProviderDeepLinkPayload,
} from '@/lib/providerDeepLink';
import { useProviderStore, useUIStore } from '@/stores';
import type { DeepLinkProviderImportResult } from '@/types';

interface MessageLike {
  success: (content: string) => unknown;
  error: (content: string) => unknown;
}

interface SubmitProviderDeepLinkDeps {
  message: MessageLike;
  setSelectedProviderId: (id: string | null) => void;
  importProvider: (payload: ProviderDeepLinkPayload) => Promise<DeepLinkProviderImportResult>;
  fetchProviders: () => Promise<void>;
  t: (key: string) => string;
}

function getSuccessMessageKey(result: DeepLinkProviderImportResult): string {
  if (result.created_provider) return 'settings.deepLinkProviderCreated';
  if (result.reused_key) return 'settings.deepLinkProviderReusedKey';
  return 'settings.deepLinkProviderKeyAdded';
}

function ProviderDeepLinkConfirmContent({
  payload,
  t,
}: {
  payload: ProviderDeepLinkPayload;
  t: SubmitProviderDeepLinkDeps['t'];
}) {
  return (
    <Descriptions size="small" column={1}>
      <Descriptions.Item label={t('common.name')}>{payload.name}</Descriptions.Item>
      <Descriptions.Item label={t('settings.apiHost')}>
        <Typography.Text code>{payload.baseurl}</Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label={t('settings.providerType')}>{payload.type}</Descriptions.Item>
      <Descriptions.Item label={t('settings.apiKey')}>
        <Typography.Text code>{getProviderDeepLinkKeyPrefix(payload.apikey)}</Typography.Text>
      </Descriptions.Item>
    </Descriptions>
  );
}

export function useProviderDeepLinkDialogState(providersSettingsVisible: boolean) {
  const [pending, setPending] = useState<ProviderDeepLinkPayload | null>(null);
  const enterSettings = useUIStore((s) => s.enterSettings);
  const setSettingsSection = useUIStore((s) => s.setSettingsSection);

  const queue = useCallback((next: ProviderDeepLinkPayload) => {
    enterSettings();
    setSettingsSection('providers');
    setPending(next);
  }, [enterSettings, setSettingsSection]);

  const clear = useCallback(() => {
    setPending(null);
  }, []);

  return {
    pending,
    open: pending !== null && providersSettingsVisible,
    queue,
    clear,
  };
}

export async function submitProviderDeepLinkImport(
  payload: ProviderDeepLinkPayload,
  deps: SubmitProviderDeepLinkDeps,
) {
  try {
    const result = await deps.importProvider(payload);
    await deps.fetchProviders();
    deps.setSelectedProviderId(result.provider_id);
    deps.message.success(deps.t(getSuccessMessageKey(result)));
  } catch (e) {
    deps.message.error(`${deps.t('settings.deepLinkProviderImportFailed')}: ${String(e)}`);
    throw e;
  }
}

export function ProviderDeepLinkConfirmModal({
  payload,
  open,
  message,
  onClear,
}: {
  payload: ProviderDeepLinkPayload | null;
  open: boolean;
  message: MessageLike;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const importProvider = useProviderStore((s) => s.importProviderFromDeepLink);
  const fetchProviders = useProviderStore((s) => s.fetchProviders);
  const setSelectedProviderId = useUIStore((s) => s.setSelectedProviderId);
  const translate = useCallback((key: string) => t(key), [t]);

  return (
    <Modal
      open={open}
      title={t('settings.deepLinkProviderConfirmTitle')}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      destroyOnHidden
      onCancel={onClear}
      onOk={async () => {
        if (!payload) return;
        await submitProviderDeepLinkImport(payload, {
          message,
          importProvider,
          fetchProviders,
          setSelectedProviderId,
          t: translate,
        });
        onClear();
      }}
    >
      {payload ? <ProviderDeepLinkConfirmContent payload={payload} t={translate} /> : null}
    </Modal>
  );
}

export function ProviderDeepLinkDialog({
  providersSettingsVisible,
}: {
  providersSettingsVisible: boolean;
}) {
  const { message } = AntdApp.useApp();
  const { pending, open, queue, clear } = useProviderDeepLinkDialogState(providersSettingsVisible);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const handleUrls = (urls: string[] | null | undefined) => {
      const parsed = urls?.map(parseProviderDeepLink).find((item): item is ProviderDeepLinkPayload => item !== null);
      if (!parsed || disposed) return;
      queue(parsed);
    };

    const setup = async () => {
      try {
        const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
        handleUrls(await getCurrent());
        unlisten = await onOpenUrl(handleUrls);
      } catch (e) {
        console.warn('Failed to initialize deep link listener:', e);
      }
    };

    void setup();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queue]);

  return (
    <ProviderDeepLinkConfirmModal
      payload={pending}
      open={open}
      message={message}
      onClear={clear}
    />
  );
}
