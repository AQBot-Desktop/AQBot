import { Space, Tag, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ModelCatalogStatus } from '@/types';

const { Text } = Typography;

const SOURCE_COLORS: Record<ModelCatalogStatus['source'], string> = {
  builtin: 'default',
  network: 'green',
  cache: 'blue',
  unavailable: 'default',
};

interface ModelCatalogStatusBarProps {
  status: ModelCatalogStatus;
}

export function ModelCatalogStatusBar({ status }: ModelCatalogStatusBarProps) {
  const { t } = useTranslation();
  const sourceKey = status.source === 'builtin' && status.configured_source === 'online'
    ? 'settings.modelCatalogBuiltinFallback'
    : `settings.modelCatalogSource.${status.source}`;
  const sourceTag = (
    <Tag color={SOURCE_COLORS[status.source]} style={{ margin: 0 }}>
      {t(sourceKey)}
    </Tag>
  );
  const detail = (
    <>
      {status.checked_at && (
        <div>
          {t('settings.modelCatalogCheckedAt')}: {new Date(status.checked_at * 1000).toLocaleString()}
        </div>
      )}
      {status.warning && <div>{status.warning}</div>}
    </>
  );

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
        {status.checked_at || status.warning
          ? <Tooltip title={detail}>{sourceTag}</Tooltip>
          : sourceTag}
        {status.freshness === 'stale' && (
          <Tag color="orange" style={{ margin: 0 }}>
            {t('settings.modelCatalogStale')}
          </Tag>
        )}
        {status.warning && status.source === 'unavailable' && (
          <Tooltip title={status.warning}>
            <Text type="danger" ellipsis style={{ maxWidth: 260, fontSize: 12 }}>
              {t('settings.modelCatalogWarning')}
            </Text>
          </Tooltip>
        )}
      </Space>
    </div>
  );
}
