import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Tag, Statistic, Row, Col, Empty, Table, theme, message } from 'antd';
import { PlayCircle, Power, Router, Copy, Check, ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import { useGatewayStore } from '@/stores/gatewayStore';
import type { GatewayRequestLog } from '@/types';
import type { ColumnsType } from 'antd/es/table';
import { formatTokenCount } from './tokenFormat';

interface GatewayOverviewProps {
  onViewMoreLogs?: () => void;
}

export function GatewayOverview({ onViewMoreLogs }: GatewayOverviewProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const {
    status,
    metrics,
    startGateway,
    stopGateway,
    fetchStatus,
    fetchMetrics,
    listRequestLogs,
  } = useGatewayStore();
  const [recentLogs, setRecentLogs] = useState<GatewayRequestLog[]>([]);
  const [recentLogsLoading, setRecentLogsLoading] = useState(false);

  const loadRecentLogs = useCallback(async () => {
    setRecentLogsLoading(true);
    try {
      const logs = await listRequestLogs(10);
      setRecentLogs(logs.slice(0, 10));
    } finally {
      setRecentLogsLoading(false);
    }
  }, [listRequestLogs]);

  useEffect(() => {
    fetchStatus();
    fetchMetrics();
    void loadRecentLogs();
  }, [fetchStatus, fetchMetrics, loadRecentLogs]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchStatus();
      fetchMetrics();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchMetrics]);

  useEffect(() => {
    if (!status.is_running) {
      return;
    }

    const interval = setInterval(() => {
      void loadRecentLogs();
    }, 5000);

    return () => clearInterval(interval);
  }, [loadRecentLogs, status.is_running]);

  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const gatewayHost =
    status.listen_address === '0.0.0.0'
      ? '127.0.0.1'
      : status.listen_address === '::' || status.listen_address === '[::]'
        ? 'localhost'
        : status.listen_address;

  const httpUrl = `http://${gatewayHost}:${status.port}/v1`;
  const httpsUrl = status.https_port != null
    ? `https://${gatewayHost}:${status.https_port}/v1`
    : null;

  const recentLogColumns: ColumnsType<GatewayRequestLog> = [
    {
      title: t('gateway.logTime'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (ts: number) => new Date(ts * 1000).toLocaleString(),
    },
    {
      title: t('gateway.logMethod'),
      dataIndex: 'method',
      key: 'method',
      width: 90,
      render: (method: string) => <Tag color="blue">{method}</Tag>,
    },
    {
      title: t('gateway.logPath'),
      dataIndex: 'path',
      key: 'path',
      ellipsis: true,
    },
    {
      title: t('gateway.logStatus'),
      dataIndex: 'statusCode',
      key: 'statusCode',
      width: 90,
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
      width: 110,
      render: (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`),
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
  ];

  const metricCardContentStyle = {
    minHeight: 82,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
  } as const;

  const tokenValueRowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  } as const;

  const handleToggle = async () => {
    try {
      if (status.is_running) {
        await stopGateway();
      } else {
        await startGateway();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      message.error(`${t('error.gatewayStartFailed')}: ${detail}`);
    }
  };

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      message.success(t('gateway.copySuccess'));
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch {
      message.error('Copy failed');
    }
  };

  const handleOpenUrl = async (url: string) => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch {
      // fallback for browser dev mode
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleViewMoreLogs = useCallback(() => {
    onViewMoreLogs?.();
  }, [onViewMoreLogs]);

  const handleRefreshRecentLogs = useCallback(() => {
    void loadRecentLogs();
  }, [loadRecentLogs]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Server Status */}
      <Card size="small">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Router size={24} />
            <div>
              <Tag color={status.is_running ? 'green' : 'default'}>
                {status.is_running ? t('gateway.running') : t('gateway.stopped')}
              </Tag>
              {status.is_running && (
                <div className="text-xs flex flex-col gap-0.5 mt-1">
                  <div className="flex items-center gap-1">
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); handleOpenUrl(httpUrl); }}
                      style={{
                        fontFamily: 'monospace',
                        color: token.colorPrimary,
                        textDecoration: 'underline dashed',
                        textUnderlineOffset: 3,
                        userSelect: 'all',
                      }}
                    >
                      {httpUrl}
                    </a>
                    <button
                      onClick={() => handleCopyUrl(httpUrl)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        padding: 2,
                        display: 'inline-flex',
                        alignItems: 'center',
                        color: copiedUrl === httpUrl ? token.colorSuccess : token.colorTextSecondary,
                      }}
                    >
                      {copiedUrl === httpUrl ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                  {status.ssl_enabled && httpsUrl && (
                    <div className="flex items-center gap-1">
                      <a
                        href="#"
                        onClick={(e) => { e.preventDefault(); handleOpenUrl(httpsUrl); }}
                        style={{
                          fontFamily: 'monospace',
                          color: token.colorPrimary,
                          textDecoration: 'underline dashed',
                          textUnderlineOffset: 3,
                          userSelect: 'all',
                        }}
                      >
                        {httpsUrl}
                      </a>
                      <button
                        onClick={() => handleCopyUrl(httpsUrl)}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          padding: 2,
                          display: 'inline-flex',
                          alignItems: 'center',
                          color: copiedUrl === httpsUrl ? token.colorSuccess : token.colorTextSecondary,
                        }}
                      >
                        {copiedUrl === httpsUrl ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>
                  )}
                  {status.ssl_enabled && status.force_ssl && (
                    <span style={{ color: token.colorWarning, fontSize: 11 }}>
                      {t('gateway.forceSslNotice')}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <Button
            type={status.is_running ? 'default' : 'primary'}
            danger={status.is_running}
            icon={status.is_running ? <Power size={16} /> : <PlayCircle size={16} />}
            onClick={handleToggle}
          >
            {status.is_running ? t('gateway.stop') : t('gateway.start')}
          </Button>
        </div>
      </Card>

      {/* Quick Metrics */}
      <Row gutter={16}>
        <Col span={6}>
          <Card size="small">
            <div style={metricCardContentStyle}>
              <Statistic title={t('gateway.todayRequests')} value={metrics?.today_requests ?? 0} />
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <div style={metricCardContentStyle}>
              <div
                style={{
                  color: token.colorTextDescription,
                  fontSize: token.fontSizeLG,
                  marginBottom: 8,
                }}
              >
                {t('gateway.todayTokens')}
              </div>
              <div style={tokenValueRowStyle}>
                <div
                  style={{
                    fontSize: 36,
                    lineHeight: 1.1,
                    fontWeight: 500,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatTokenCount(metrics?.today_tokens ?? 0)}
                </div>
                <Tag icon={<ArrowDown size={12} />} color="blue">
                  {formatTokenCount(metrics?.today_request_tokens ?? 0)}
                </Tag>
                <Tag icon={<ArrowUp size={12} />} color="purple">
                  {formatTokenCount(metrics?.today_response_tokens ?? 0)}
                </Tag>
              </div>
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <div style={metricCardContentStyle}>
              <Statistic title={t('gateway.totalRequests')} value={metrics?.total_requests ?? 0} />
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <div style={metricCardContentStyle}>
              <div
                style={{
                  color: token.colorTextDescription,
                  fontSize: token.fontSizeLG,
                  marginBottom: 8,
                }}
              >
                {t('gateway.totalTokens')}
              </div>
              <div style={tokenValueRowStyle}>
                <div
                  style={{
                    fontSize: 36,
                    lineHeight: 1.1,
                    fontWeight: 500,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatTokenCount(metrics?.total_tokens ?? 0)}
                </div>
                <Tag icon={<ArrowDown size={12} />} color="blue">
                  {formatTokenCount(metrics?.total_request_tokens ?? 0)}
                </Tag>
                <Tag icon={<ArrowUp size={12} />} color="purple">
                  {formatTokenCount(metrics?.total_response_tokens ?? 0)}
                </Tag>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Recent Request Logs */}
      <Card
        size="small"
        title={t('gateway.recentRequestLogs')}
        extra={(
          <Button
            size="small"
            icon={<RefreshCw size={14} />}
            onClick={handleRefreshRecentLogs}
          >
            {t('common.refresh')}
          </Button>
        )}
      >
        {recentLogs.length === 0 && !recentLogsLoading ? (
          <Empty description={t('gateway.noLogs')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table
            dataSource={recentLogs}
            columns={recentLogColumns}
            rowKey="id"
            loading={recentLogsLoading}
            pagination={false}
            size="small"
            scroll={{ x: 1080 }}
          />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <Button type="link" onClick={handleViewMoreLogs}>
            {t('gateway.viewMoreLogs')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
