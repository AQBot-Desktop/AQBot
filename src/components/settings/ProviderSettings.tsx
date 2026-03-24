import { useEffect } from 'react';
import { theme } from 'antd';
import { useProviderStore, useUIStore } from '@/stores';
import { ProviderList } from './ProviderList';
import { ProviderDetail } from './ProviderDetail';
import { useTranslation } from 'react-i18next';

export function ProviderSettings() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const fetchProviders = useProviderStore((s) => s.fetchProviders);
  const selectedProviderId = useUIStore((s) => s.selectedProviderId);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  return (
    <div className="flex h-full">
      <div className="w-64 shrink-0 pt-2" style={{ borderRight: '1px solid var(--border-color)' }}>
        <ProviderList />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-4 pt-4">
        {selectedProviderId ? (
          <ProviderDetail providerId={selectedProviderId} />
        ) : (
          <div className="flex h-full items-center justify-center" style={{ color: token.colorTextSecondary }}>
            <p>{t('settings.selectProvider')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
