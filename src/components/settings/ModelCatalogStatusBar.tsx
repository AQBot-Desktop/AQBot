import { Space, Tag, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ModelCatalogStatus } from '@/types';

const { Text } = Typography;

const SOURCE_COLORS: Record<ModelCatalogStatus['source'], string> = {
  network: 'green',
  cache: 'blue',
  unavailable: 'default',
};

interface ModelCatalogStatusBarProps {
  status: ModelCatalogStatus;
}

export function ModelCatalogStatusBar({ status }: ModelCatalogStatusBarProps) {
  const { t } = useTranslation();
  const checkedAt = status.checked_at
    ? new Date(status.checked_at * 1000).toLocaleString()
    : t('settings.modelCatalogNeverChecked');

  return (
    <div
      style={{
        padding: '6px 24px',
        borderBottom: '1px solid var(--ant-color-border-secondary)',
      }}
    >
      <Space size={[4, 4]} wrap>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('settings.modelCatalogMatched')}: {status.matched_context_windows}/{status.total_chat_models}
        </Text>
        <Tooltip title={`${t('settings.modelCatalogCheckedAt')}: ${checkedAt}`}>
          <Tag color={SOURCE_COLORS[status.source]} style={{ margin: 0 }}>
            {t(`settings.modelCatalogSource.${status.source}`)}
          </Tag>
        </Tooltip>
        {status.freshness === 'stale' && (
          <Tag color="orange" style={{ margin: 0 }}>
            {t('settings.modelCatalogStale')}
          </Tag>
        )}
        {status.warning && (
          <Tooltip title={status.warning}>
            <Text type="warning" ellipsis style={{ maxWidth: 260, fontSize: 12 }}>
              {t('settings.modelCatalogWarning')}
            </Text>
          </Tooltip>
        )}
      </Space>
    </div>
  );
}
