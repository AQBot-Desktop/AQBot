import { useState } from 'react';
import { Button, Card, Divider, Input, InputNumber, Select, App } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores';
import { invoke } from '@/lib/invoke';

export function ProxySettings() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const [testing, setTesting] = useState(false);

  const handleTestProxy = async () => {
    const { proxy_type, proxy_address, proxy_port } = settings;

    if (!proxy_address) {
      message.warning(t('settings.proxyAddressRequired') || '请先填写代理地址');
      return;
    }

    setTesting(true);
    try {
      const result = await invoke<{ ok: boolean; latency_ms?: number; error?: string }>('test_proxy', {
        proxyType: proxy_type || 'http',
        proxyAddress: proxy_address,
        proxyPort: proxy_port || 7890,
      });

      if (result.ok) {
        message.success(
          `${t('settings.proxyTestSuccess') || '代理连接成功'}${result.latency_ms ? ` (${result.latency_ms}ms)` : ''}`
        );
      } else {
        message.error(result.error || t('settings.proxyTestFailed') || '代理连接失败');
      }
    } catch {
      message.error(t('settings.proxyTestFailed') || '代理连接失败');
    } finally {
      setTesting(false);
    }
  };

  const rowStyle = { padding: '4px 0' };

  return (
    <div className="p-6 pb-12">
      <Card size="small" title={t('settings.groupProxy')}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.proxyType')}</span>
          <Select
            value={settings.proxy_type ?? 'none'}
            onChange={(val) =>
              saveSettings({ proxy_type: val === 'none' ? null : val })
            }
            style={{ width: 200 }}
            options={[
              { label: t('settings.proxyNone'), value: 'none' },
              { label: t('settings.proxyHttp'), value: 'http' },
              { label: t('settings.proxySocks5'), value: 'socks5' },
            ]}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.proxyAddress')}</span>
          <Input
            value={settings.proxy_address ?? ''}
            onChange={(e) =>
              saveSettings({ proxy_address: e.target.value || null })
            }
            placeholder="127.0.0.1"
            disabled={!settings.proxy_type}
            style={{ width: 280 }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.proxyPort')}</span>
          <InputNumber
            value={settings.proxy_port}
            onChange={(val) => saveSettings({ proxy_port: val ?? null })}
            placeholder="7890"
            disabled={!settings.proxy_type}
            min={1}
            max={65535}
            style={{ width: 150 }}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={{ padding: '4px 0', display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={handleTestProxy} disabled={!settings.proxy_type} loading={testing}>
            {t('settings.testProxy')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
