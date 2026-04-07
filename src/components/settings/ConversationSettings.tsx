import { Card, Divider, Input, Select, Switch, theme } from 'antd';
import { Map, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores';

const { TextArea } = Input;

export function ConversationSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const { token } = theme.useToken();
  const rowStyle = { padding: '4px 0' };

  return (
    <div style={{ padding: 24 }}>
      <Card
        size="small"
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageSquare size={16} />
            {t('settings.defaultSystemPrompt')}
          </span>
        }
      >
        <div style={{ fontSize: 12, color: token.colorTextDescription, marginBottom: 12 }}>
          {t('settings.defaultSystemPromptDesc')}
        </div>
        <TextArea
          value={settings.default_system_prompt ?? ''}
          onChange={(e) => saveSettings({ default_system_prompt: e.target.value || null })}
          placeholder={t('settings.defaultSystemPromptPlaceholder')}
          autoSize={{ minRows: 3, maxRows: 10 }}
        />
      </Card>

      <Card size="small" title={t('settings.groupMessageStyle')} style={{ marginTop: 16 }}>
        <div className="flex items-center justify-between" style={rowStyle}>
          <span>{t('settings.bubbleStyle')}</span>
          <Select
            value={settings.bubble_style}
            onChange={(val) => saveSettings({ bubble_style: val })}
            style={{ width: 200 }}
            options={[
              { label: t('settings.bubbleModern'), value: 'modern' },
              { label: t('settings.bubbleCompact'), value: 'compact' },
              { label: t('settings.bubbleMinimal'), value: 'minimal' },
            ]}
          />
        </div>
      </Card>

      <Card
        size="small"
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Map size={16} />
            {t('settings.chatMinimap')}
          </span>
        }
        style={{ marginTop: 16 }}
      >
        <div style={{ fontSize: 12, color: token.colorTextDescription, marginBottom: 12 }}>
          {t('settings.chatMinimapEnabledDesc')}
        </div>
        <div className="flex items-center justify-between" style={rowStyle}>
          <span>{t('settings.chatMinimapEnabled')}</span>
          <Switch
            checked={settings.chat_minimap_enabled ?? false}
            onChange={(checked) => saveSettings({ chat_minimap_enabled: checked })}
          />
        </div>
        {settings.chat_minimap_enabled && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <div className="flex items-center justify-between" style={rowStyle}>
              <span>{t('settings.chatMinimapStyle')}</span>
              <Select
                value={settings.chat_minimap_style ?? 'faq'}
                onChange={(val) => saveSettings({ chat_minimap_style: val as 'faq' | 'sticky' })}
                style={{ width: 200 }}
                options={[
                  { label: t('settings.chatMinimapFaq'), value: 'faq' },
                  { label: t('settings.chatMinimapSticky'), value: 'sticky' },
                ]}
              />
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
