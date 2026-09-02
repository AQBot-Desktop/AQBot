import { Button, Divider, Modal, Switch, theme } from 'antd';
import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AGENT_ALLOWED_TOOL_GROUP_I18N_KEYS,
  AGENT_ALLOWED_TOOL_GROUPS,
  AGENT_CONFIGURABLE_TOOLS,
  defaultAgentAllowedTools,
  isConfigurableAgentTool,
} from '@/lib/agentAllowedTools';
import { useSettingsStore } from '@/stores';

interface AgentAllowedToolsSettingsProps {
  rowStyle: CSSProperties;
}

export function AgentAllowedToolsSettings({ rowStyle }: AgentAllowedToolsSettingsProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const settings = useSettingsStore((state) => state.settings);
  const saveSettings = useSettingsStore((state) => state.saveSettings);
  const [open, setOpen] = useState(false);
  const enabled = settings.agent_allowed_tools_enabled ?? false;
  const selected = settings.agent_allowed_tools ?? defaultAgentAllowedTools();
  const selectedSet = new Set(selected);
  const selectedCount = selected.filter((name) => isConfigurableAgentTool(name)).length;

  const persistSelection = (next: string[]) => {
    saveSettings({ agent_allowed_tools: next });
  };

  const toggleTool = (toolId: string, checked: boolean) => {
    if (checked) {
      if (selectedSet.has(toolId)) return;
      persistSelection([...selected, toolId]);
      return;
    }
    persistSelection(selected.filter((name) => name !== toolId));
  };

  const selectAll = () => {
    const extras = selected.filter((name) => !isConfigurableAgentTool(name));
    persistSelection([...AGENT_CONFIGURABLE_TOOLS, ...extras]);
  };

  const clearAll = () => {
    persistSelection([]);
  };

  return (
    <div>
      <Divider style={{ margin: '4px 0' }} />
      <div style={{ fontSize: 12, color: token.colorTextDescription, marginBottom: 8 }}>
        {t('settings.agentAllowedToolsDesc')}
      </div>
      <div className="flex items-center justify-between" style={rowStyle}>
        <div>
          <div>{t('settings.agentAllowedToolsEnable')}</div>
          <div style={{ fontSize: 12, color: token.colorTextDescription }}>
            {t('settings.agentAllowedToolsEnableDesc')}
          </div>
        </div>
        <Switch
          aria-label={t('settings.agentAllowedToolsEnable')}
          checked={enabled}
          onChange={(checked) => saveSettings({ agent_allowed_tools_enabled: checked })}
        />
      </div>
      <div className="flex items-center justify-between gap-3" style={rowStyle}>
        <div style={{ fontSize: 12, color: token.colorTextDescription }}>
          {t('settings.agentAllowedToolsSelectedCount', {
            count: selectedCount,
            total: AGENT_CONFIGURABLE_TOOLS.length,
          })}
        </div>
        <Button
          aria-label={t('settings.agentAllowedToolsConfigure')}
          onClick={() => setOpen(true)}
        >
          {t('settings.agentAllowedToolsConfigure')}
        </Button>
      </div>
      <Modal
        title={t('settings.agentAllowedToolsModalTitle')}
        open={open}
        onCancel={() => setOpen(false)}
        footer={
          <Button onClick={() => setOpen(false)}>
            {t('common.close')}
          </Button>
        }
        width={560}
        mask={{ enabled: true, blur: true }}
      >
        <div className="flex items-center justify-end gap-2" style={{ marginBottom: 8 }}>
          <Button aria-label={t('settings.agentAllowedToolsSelectAll')} onClick={selectAll}>
            {t('settings.agentAllowedToolsSelectAll')}
          </Button>
          <Button aria-label={t('settings.agentAllowedToolsClear')} onClick={clearAll}>
            {t('settings.agentAllowedToolsClear')}
          </Button>
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {AGENT_ALLOWED_TOOL_GROUPS.map((group) => (
            <div key={group.id} style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: token.colorTextDescription, marginBottom: 4 }}>
                {t(AGENT_ALLOWED_TOOL_GROUP_I18N_KEYS[group.id])}
              </div>
              {group.tools.map((toolId) => (
                <div key={toolId} className="flex items-center justify-between" style={rowStyle}>
                  <span>{toolId}</span>
                  <Switch
                    aria-label={t('settings.agentAllowedToolToggle', { name: toolId })}
                    checked={selectedSet.has(toolId)}
                    onChange={(checked) => toggleTool(toolId, checked)}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: token.colorTextDescription, marginTop: 12 }}>
          {t('settings.agentAllowedToolsMcpNote')}
        </div>
        <div style={{ fontSize: 12, color: token.colorTextDescription, marginTop: 4 }}>
          {t('settings.agentAllowedToolsPermissionNote')}
        </div>
        {selectedCount === 0 && (
          <div style={{ fontSize: 12, color: token.colorTextDescription, marginTop: 4 }}>
            {t('settings.agentAllowedToolsEmptyHint')}
          </div>
        )}
      </Modal>
    </div>
  );
}
