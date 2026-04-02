import { useCallback } from 'react';
import { App, Progress, Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@/lib/invoke';

/**
 * Shared hook for checking app updates.
 * Used by TitleBar, App.tsx, and AboutPage to avoid duplicated logic.
 */
export function useUpdateChecker() {
  const { t } = useTranslation();
  const { modal, message } = App.useApp();

  const checkForUpdate = useCallback(async (options?: { silent?: boolean }) => {
    if (!isTauri()) return false;
    const silent = options?.silent ?? false;
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        if (!silent) message.success(t('settings.noUpdate', '当前已是最新版本'));
        return false;
      }

      modal.confirm({
        title: t('settings.updateAvailable'),
        content: (
          <div>
            <p>{t('settings.newVersion')}: {update.version}</p>
            {update.body && (
              <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 13, opacity: 0.85 }}>
                {update.body}
              </div>
            )}
          </div>
        ),
        okText: t('settings.updateNow'),
        cancelText: t('settings.updateLater'),
        onOk: async () => {
          let cancelled = false;
          const handleCancel = async () => {
            cancelled = true;
            try { await update.close(); } catch { /* ignore */ }
          };
          const renderContent = (percent: number, status: 'active' | 'success') => (
            <div>
              <Progress percent={percent} status={status} />
              {status !== 'success' && (
                <div style={{ textAlign: 'right', marginTop: 12 }}>
                  <Button onClick={handleCancel}>{t('settings.cancelUpdate')}</Button>
                </div>
              )}
            </div>
          );
          const progressModal = modal.info({
            title: t('settings.updating', '正在更新...'),
            content: renderContent(0, 'active'),
            closable: false,
            footer: null,
            maskClosable: false,
            keyboard: false,
          });
          try {
            let totalSize = 0;
            let downloaded = 0;
            await update.downloadAndInstall((event) => {
              if (event.event === 'Started' && event.data.contentLength) {
                totalSize = event.data.contentLength;
              } else if (event.event === 'Progress') {
                downloaded += event.data.chunkLength;
                if (totalSize > 0) {
                  progressModal.update({
                    content: renderContent(Math.round((downloaded / totalSize) * 100), 'active'),
                  });
                }
              } else if (event.event === 'Finished') {
                progressModal.update({ content: renderContent(100, 'success') });
              }
            });
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
          } catch (e) {
            progressModal.destroy();
            if (!cancelled) {
              message.error(t('settings.updateFailed', '更新失败'));
              console.error('Update install failed:', e);
            }
          }
        },
      });
      return true;
    } catch (e) {
      if (!silent) message.error(t('settings.checkUpdateFailed', '检查更新失败，请稍后再试'));
      console.error('Update check failed:', e);
      return false;
    }
  }, [t, modal, message]);

  return { checkForUpdate };
}
