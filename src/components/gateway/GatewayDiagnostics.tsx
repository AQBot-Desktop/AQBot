import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Button, Tag, Empty, Popconfirm, Modal } from 'antd';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useGatewayStore } from '@/stores/gatewayStore';
import type { GatewayRequestLog } from '@/types';
import type { ColumnsType } from 'antd/es/table';
import { formatTokenCount } from './tokenFormat';

export function GatewayDiagnostics() {
  const { t } = useTranslation();
  const { requestLogs, requestLogsLoading, fetchRequestLogs, clearRequestLogs } = useGatewayStore();
  const [selectedErrorMessage, setSelectedErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetchRequestLogs();
  }, [fetchRequestLogs]);

  const columns: ColumnsType<GatewayRequestLog> = [
    {
      title: t('gateway.logTime'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (ts: number) => {
        const d = new Date(ts * 1000);
        return d.toLocaleString();
      },
    },
    {
      title: t('gateway.logMethod'),
      dataIndex: 'method',
      key: 'method',
      width: 80,
      render: (method: string) => (
        <Tag color="blue">{method}</Tag>
      ),
    },
    {
      title: t('gateway.logPath'),
      dataIndex: 'path',
      key: 'path',
      width: 200,
      ellipsis: true,
    },
    {
      title: t('gateway.logModel'),
      dataIndex: 'model',
      key: 'model',
      width: 160,
      ellipsis: true,
      render: (model: string | null) => model || '-',
    },
    {
      title: t('gateway.logStatus'),
      dataIndex: 'statusCode',
      key: 'statusCode',
      width: 80,
      render: (code: number) => (
        <Tag color={code >= 200 && code < 300 ? 'green' : code >= 400 ? 'red' : 'orange'}>
          {code}
        </Tag>
      ),
    },
    {
      title: t('gateway.logDuration'),
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 100,
      render: (ms: number) => {
        if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
        return `${ms}ms`;
      },
    },
    {
      title: t('gateway.logRequestTokens'),
      dataIndex: 'requestTokens',
      key: 'requestTokens',
      width: 140,
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
    {
      title: t('gateway.logResponseTokens'),
      dataIndex: 'responseTokens',
      key: 'responseTokens',
      width: 140,
      render: (value: number) => (value === 0 ? '-' : formatTokenCount(value)),
    },
    {
      title: t('gateway.totalTokens'),
      key: 'totalTokens',
      width: 120,
      render: (_: unknown, record: GatewayRequestLog) => {
        const total = record.requestTokens + record.responseTokens;
        return total === 0 ? '-' : formatTokenCount(total);
      },
    },
    {
      title: t('gateway.logKey'),
      dataIndex: 'keyName',
      key: 'keyName',
      width: 120,
      ellipsis: true,
    },
    {
      title: t('gateway.logError'),
      dataIndex: 'errorMessage',
      key: 'errorMessage',
      ellipsis: true,
      render: (msg: string | null) =>
        msg ? (
          <button
            type="button"
            onClick={() => setSelectedErrorMessage(msg)}
            style={{
              border: 'none',
              padding: 0,
              background: 'transparent',
              color: '#ff4d4f',
              width: '100%',
              textAlign: 'left',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {msg}
          </button>
        ) : null,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <Popconfirm
          title={t('gateway.clearLogsConfirm')}
          onConfirm={clearRequestLogs}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
        >
          <Button
            icon={<Trash2 size={14} />}
            danger
            disabled={requestLogs.length === 0}
          >
            {t('gateway.clearLogs')}
          </Button>
        </Popconfirm>
        <Button
          icon={<RefreshCw size={14} />}
          onClick={() => void fetchRequestLogs()}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {requestLogs.length === 0 && !requestLogsLoading ? (
        <Empty
          description={t('gateway.noLogs')}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <Table
          dataSource={requestLogs}
          columns={columns}
          rowKey="id"
          loading={requestLogsLoading}
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (total) => `${total} ${t('gateway.logTotalRecords')}`,
          }}
          size="small"
          scroll={{ x: 1200 }}
        />
      )}
      <Modal
        open={selectedErrorMessage != null}
        title={t('gateway.logError')}
        onCancel={() => setSelectedErrorMessage(null)}
        footer={null}
      >
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#ff4d4f' }}>
          {selectedErrorMessage}
        </div>
      </Modal>
    </div>
  );
}
