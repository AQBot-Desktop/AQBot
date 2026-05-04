import { Divider, Input, Switch, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores';
import { SettingsGroup } from './SettingsGroup';
import { SettingsSelect } from './SettingsSelect';

const { TextArea } = Input;

export function ConversationSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const { token } = theme.useToken();
  const rowStyle = { padding: '4px 0' };

  return (
    <div style={{ padding: 24 }}>
      <SettingsGroup title={t('settings.defaultSystemPrompt')}>
        <div style={{ fontSize: 12, color: token.colorTextDescription, marginBottom: 12 }}>
          {t('settings.defaultSystemPromptDesc')}
        </div>
        <TextArea
          value={settings.default_system_prompt ?? ''}
          onChange={(e) => saveSettings({ default_system_prompt: e.target.value || null })}
          placeholder={t('settings.defaultSystemPromptPlaceholder')}
          autoSize={{ minRows: 3, maxRows: 10 }}
        />
      </SettingsGroup>

      <SettingsGroup title={t('settings.groupMessageStyle')}>
        <div className="flex items-center justify-between" style={rowStyle}>
          <span>{t('settings.bubbleStyle')}</span>
          <SettingsSelect
            value={settings.bubble_style}
            onChange={(val) => saveSettings({ bubble_style: val })}
            options={[
              { label: t('settings.bubbleModern'), value: 'modern' },
              { label: t('settings.bubbleCompact'), value: 'compact' },
              { label: t('settings.bubbleMinimal'), value: 'minimal' },
            ]}
          />
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div className="flex items-center justify-between" style={rowStyle}>
          <div>
            <div>{t('settings.renderUserMarkdown')}</div>
            <div style={{ fontSize: 12, color: token.colorTextDescription }}>{t('settings.renderUserMarkdownDesc')}</div>
          </div>
          <Switch
            checked={settings.render_user_markdown ?? false}
            onChange={(checked) => saveSettings({ render_user_markdown: checked })}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.multiModelDisplayMode')}>
        <div style={{ fontSize: 12, color: token.colorTextDescription, marginBottom: 12 }}>
          {t('settings.multiModelDisplayModeDesc')}
        </div>
        <div className="flex items-center justify-between" style={rowStyle}>
          <span>{t('settings.multiModelDisplayMode')}</span>
          <SettingsSelect
            value={settings.multi_model_display_mode ?? 'tabs'}
            onChange={(val) => saveSettings({ multi_model_display_mode: val as 'tabs' | 'side-by-side' | 'stacked' })}
            options={[
              { label: t('settings.multiModelDisplayModeTabs'), value: 'tabs' },
              { label: t('settings.multiModelDisplayModeSideBySide'), value: 'side-by-side' },
              { label: t('settings.multiModelDisplayModeStacked'), value: 'stacked' },
            ]}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.chatMinimap')}>
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
              <SettingsSelect
                value={settings.chat_minimap_style ?? 'faq'}
                onChange={(val) => saveSettings({ chat_minimap_style: val as 'faq' | 'sticky' })}
                options={[
                  { label: t('settings.chatMinimapFaq'), value: 'faq' },
                  { label: t('settings.chatMinimapSticky'), value: 'sticky' },
                ]}
              />
            </div>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title={t('settings.additionalFeatures')}>
        <div className="flex items-center justify-between" style={rowStyle}>
          <span>{t('settings.showImageModelsInModelSelector')}</span>
          <Switch
            checked={settings.show_image_models_in_model_selector ?? false}
            onChange={(checked) => saveSettings({ show_image_models_in_model_selector: checked })}
          />
        </div>
      </SettingsGroup>
    </div>
  );
}
