import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs } from 'antd';
import { Gauge, Key, BarChart3, Settings, ScrollText } from 'lucide-react';
import {
  GatewayOverview,
  GatewayKeys,
  GatewayMetrics,
  GatewaySettings,
  GatewayDiagnostics,
  GatewayTemplates,
  QuickConnectCycleIcon,
} from '@/components/gateway';
import { useGatewayStore } from '@/stores/gatewayStore';

export function GatewayPage() {
  const { t } = useTranslation();
  const { fetchRequestLogs } = useGatewayStore();
  const [activeKey, setActiveKey] = useState('overview');

  const handleViewMoreLogs = useCallback(() => {
    setActiveKey('diagnostics');
    void fetchRequestLogs();
  }, [fetchRequestLogs]);

  const items = [
    {
      key: 'overview',
      label: t('gateway.overview'),
      icon: <Gauge size={16} />,
      children: <GatewayOverview onViewMoreLogs={handleViewMoreLogs} />,
    },
    {
      key: 'keys',
      label: t('gateway.keys'),
      icon: <Key size={16} />,
      children: <GatewayKeys />,
    },
    {
      key: 'metrics',
      label: t('gateway.metrics'),
      icon: <BarChart3 size={16} />,
      children: <GatewayMetrics />,
    },
    {
      key: 'diagnostics',
      label: t('gateway.logs'),
      icon: <ScrollText size={16} />,
      children: <GatewayDiagnostics />,
    },
    {
      key: 'quickConnect',
      label: t('gateway.quickConnect'),
      icon: <QuickConnectCycleIcon size={16} />,
      children: <GatewayTemplates />,
    },
    {
      key: 'settings',
      label: t('gateway.settings'),
      icon: <Settings size={16} />,
      children: <GatewaySettings />,
    },
  ];

  return (
    <div className="h-full flex flex-col px-2" style={{ overflow: 'hidden' }}>
      <Tabs
        items={items}
        activeKey={activeKey}
        onChange={setActiveKey}
        className="flex-1"
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
        tabBarStyle={{ flexShrink: 0 }}
      />
      <style>{`
        .h-full > .ant-tabs > .ant-tabs-content-holder {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          min-height: 0;
        }
      `}</style>
    </div>
  );
}
