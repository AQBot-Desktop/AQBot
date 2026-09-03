import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Image, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import { invoke, isTauri, listen } from '@/lib/invoke';
import { buildStoredMediaUrl } from '@/lib/storedMedia';
import { useSettingsStore } from '@/stores/settingsStore';
import colorIcon from '../../../src-tauri/icons/64x64.png';
import monochromeIcon from '../../../src-tauri/icons/tray-monochrome.png';

interface TrayIconStatus {
  revision: number;
  trayIconFileId: string | null;
  applied: boolean;
  error: string | null;
  warnings: string[];
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('tray_icon_invalid'));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(new Error('tray_icon_invalid'));
    reader.readAsDataURL(file);
  });
}

function acceptStatus(status: TrayIconStatus) {
  if (status.revision < useSettingsStore.getState().trayIconRevision) return false;
  useSettingsStore.setState((state) => ({
    trayIconRevision: status.revision,
    settings: { ...state.settings, tray_icon_file_id: status.trayIconFileId },
    settingsMeta: { ...state.settingsMeta, revision: state.settingsMeta.revision
      + Number(state.settings.tray_icon_file_id !== status.trayIconFileId) },
  }));
  return true;
}

export function TrayIconSettings({ monochrome }: { monochrome: boolean }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const settings = useSettingsStore((state) => state.settings);
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState<{ file: File; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [status, setStatus] = useState<TrayIconStatus | null>(null);
  const desktop = isTauri();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => () => {
    if (pending) URL.revokeObjectURL(pending.url);
  }, [pending]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let revision = 0;
    const receive = (value: TrayIconStatus) => {
      if (disposed) return;
      revision += 1;
      if (acceptStatus(value)) setStatus(value);
    };
    const requestRevision = revision;
    const subscription = listen<TrayIconStatus>('aqbot:tray-icon-changed', ({ payload }) => receive(payload));
    void subscription.then(async () => {
      const value = await invoke<TrayIconStatus>('get_tray_icon_status');
      if (revision === requestRevision) receive(value);
    }).catch((error) => {
      console.error('[trayIcon] status unavailable', error);
      if (!disposed) setErrorKey('settings.customTrayIcon.failed');
    });
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten()).catch((error) => {
        console.error('[trayIcon] listener cleanup failed', error);
      });
    };
  }, [desktop, settings.tray_enabled, settings.tray_icon_style]);

  const selectFile = (file: File | undefined) => {
    if (!file) return;
    setErrorKey(null);
    if (file.size === 0 || file.size > 5 * 1024 * 1024) {
      setErrorKey('settings.customTrayIcon.sizeError');
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setErrorKey('settings.customTrayIcon.invalid');
      return;
    }
    setPending({ file, url: URL.createObjectURL(file) });
  };

  const apply = async (reset: boolean) => {
    if (busyRef.current || (!reset && !pending)) return;
    busyRef.current = true;
    setBusy(true);
    setErrorKey(null);
    try {
      const value = reset
        ? await invoke<TrayIconStatus>('reset_tray_icon')
        : await invoke<TrayIconStatus>('set_custom_tray_icon', {
          data: await readImage(pending!.file), mimeType: pending!.file.type,
        });
      const accepted = acceptStatus(value);
      if (!mounted.current) return;
      if (accepted) setStatus(value);
      setPending(null);
      if (value.warnings.includes('tray_icon_cleanup_failed')) {
        message.warning(t('settings.customTrayIcon.cleanupFailed'));
      } else if (value.warnings.length) {
        message.warning(t('settings.customTrayIcon.notificationFailed'));
      } else {
        message.success(t(value.applied ? 'settings.customTrayIcon.applied' : 'settings.customTrayIcon.deferred'));
      }
    } catch (error) {
      console.error('[trayIcon] update failed', error);
      if (mounted.current) {
        const detail = String(error);
        setErrorKey(detail.includes('tray_icon_size') ? 'settings.customTrayIcon.sizeError'
          : /tray_icon_(invalid|format)/.test(detail) ? 'settings.customTrayIcon.invalid'
            : 'settings.customTrayIcon.failed');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const fileId = settings.tray_icon_file_id;
  const preview = pending?.url ?? (fileId ? buildStoredMediaUrl(fileId) : monochrome ? monochromeIcon : colorIcon);
  const visibleError = errorKey ?? (status?.error ? 'settings.customTrayIcon.loadFailed' : null);

  return (
    <div className="flex flex-col gap-2" style={{ padding: '4px 0' }}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div>{t('settings.customTrayIcon.title')}</div>
          <div style={{ color: 'var(--ant-color-text-secondary)', fontSize: 12 }}>
            {t('settings.customTrayIcon.hint')}
          </div>
          {fileId && <div>{t('settings.customTrayIcon.originalColors')}</div>}
          {!settings.tray_enabled && <div>{t('settings.customTrayIcon.deferred')}</div>}
        </div>
        <Image key={preview} src={preview} width={48} height={48}
          style={{ objectFit: 'contain' }} alt={t('settings.customTrayIcon.preview')}
          preview={{ mask: { blur: true }, scaleStep: 0.5 }}
          onError={() => setErrorKey('settings.customTrayIcon.invalid')} />
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden
        aria-label={t('settings.customTrayIcon.choose')} disabled={!desktop || busy}
        onChange={(event) => { selectFile(event.target.files?.[0]); event.target.value = ''; }} />
      <Space wrap>
        <Button disabled={!desktop || busy} onClick={() => input.current?.click()}>{t('settings.customTrayIcon.choose')}</Button>
        {pending && <>
          <Button type="primary" disabled={!desktop} loading={busy} onClick={() => void apply(false)}>{t('settings.customTrayIcon.apply')}</Button>
          <Button disabled={busy} onClick={() => { setPending(null); setErrorKey(null); }}>{t('common.cancel')}</Button>
        </>}
        <Button disabled={!desktop || busy || !fileId} onClick={() => void apply(true)}>{t('settings.customTrayIcon.reset')}</Button>
      </Space>
      {visibleError && <Alert type="error" showIcon title={t(visibleError)} />}
    </div>
  );
}
