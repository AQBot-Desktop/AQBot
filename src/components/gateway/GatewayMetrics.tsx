import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Card } from 'antd';
import { useGatewayStore } from '@/stores/gatewayStore';
import { formatTokenCount } from './tokenFormat';

export function GatewayMetrics() {
  const { t } = useTranslation();
  const {
    usageByDay,
    usageByProvider,
    usageByKey,
    fetchUsageByDay,
    fetchUsageByProvider,
    fetchUsageByKey,
  } = useGatewayStore();

  useEffect(() => {
    fetchUsageByDay(30);
    fetchUsageByProvider();
    fetchUsageByKey();
  }, [fetchUsageByDay, fetchUsageByProvider, fetchUsageByKey]);

  const dayColumns = [
    { title: t('gateway.date'), dataIndex: 'date', key: 'date' },
    {
      title: t('gateway.totalRequests'),
      dataIndex: 'request_count',
      key: 'request_count',
    },
    {
      title: t('gateway.logRequestTokens'),
      dataIndex: 'request_tokens',
      key: 'request_tokens',
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
    {
      title: t('gateway.logResponseTokens'),
      dataIndex: 'response_tokens',
      key: 'response_tokens',
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
    {
      title: t('gateway.totalTokens'),
      dataIndex: 'token_count',
      key: 'token_count',
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
  ];

  const providerColumns = [
    { title: t('gateway.provider'), dataIndex: 'provider_name', key: 'provider_name' },
    {
      title: t('gateway.totalRequests'),
      dataIndex: 'request_count',
      key: 'request_count',
    },
    {
      title: t('gateway.logRequestTokens'),
      dataIndex: 'request_tokens',
      key: 'request_tokens',
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
    {
      title: t('gateway.logResponseTokens'),
      dataIndex: 'response_tokens',
      key: 'response_tokens',
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
    {
      title: t('gateway.totalTokens'),
      dataIndex: 'token_count',
      key: 'token_count',
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
  ];

  const keyColumns = [
    { title: t('gateway.keyName'), dataIndex: 'key_name', key: 'key_name' },
    {
      title: t('gateway.totalRequests'),
      dataIndex: 'request_count',
      key: 'request_count',
    },
    {
      title: t('gateway.logRequestTokens'),
      dataIndex: 'request_tokens',
      key: 'request_tokens',
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
    {
      title: t('gateway.logResponseTokens'),
      dataIndex: 'response_tokens',
      key: 'response_tokens',
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
    {
      title: t('gateway.totalTokens'),
      dataIndex: 'token_count',
      key: 'token_count',
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" title={t('gateway.usageByDay')}>
        <Table
          dataSource={usageByDay}
          columns={dayColumns}
          rowKey="date"
          pagination={false}
          size="small"
        />
      </Card>

      <Card size="small" title={t('gateway.usageByProvider')}>
        <Table
          dataSource={usageByProvider}
          columns={providerColumns}
          rowKey="provider_id"
          pagination={false}
          size="small"
        />
      </Card>

      <Card size="small" title={t('gateway.usageByKey')}>
        <Table
          dataSource={usageByKey}
          columns={keyColumns}
          rowKey="key_id"
          pagination={false}
          size="small"
        />
      </Card>
    </div>
  );
}
