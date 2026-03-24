import { Button, Card, Divider, Popconfirm, Typography, App } from 'antd';
import { Share2, Upload, Trash2, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConversationStore, useSettingsStore } from '@/stores';
import { isTauri } from '@/lib/invoke';

const { Text } = Typography;

export function DataManager() {
  const { t } = useTranslation();
  const { message } = App.useApp();

  const handleExport = async () => {
    try {
      const conversations = useConversationStore.getState().conversations;
      const settings = useSettingsStore.getState().settings;

      const exportData = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        conversations,
        settings,
      };

      const jsonStr = JSON.stringify(exportData, null, 2);

      if (isTauri()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        const filePath = await save({
          defaultPath: `aqbot-export-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (filePath) {
          await writeTextFile(filePath, jsonStr);
          message.success(t('settings.exportSuccess') || '导出成功');
        }
      } else {
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aqbot-export-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        message.success(t('settings.exportSuccess') || '导出成功');
      }
    } catch (e) {
      console.error('Export failed:', e);
      message.error(t('error.unknown') || '导出失败');
    }
  };

  const handleImport = async () => {
    try {
      let jsonStr: string | null = null;

      if (isTauri()) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const filePath = await open({
          filters: [{ name: 'JSON', extensions: ['json'] }],
          multiple: false,
        });
        if (filePath) {
          jsonStr = await readTextFile(filePath as string);
        }
      } else {
        jsonStr = await new Promise<string | null>((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json';
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsText(file);
          };
          input.click();
        });
      }

      if (!jsonStr) return;

      const data = JSON.parse(jsonStr);
      if (!data.version) {
        message.error(t('error.invalidFormat') || '无效的导入文件格式');
        return;
      }

      if (data.settings) {
        await useSettingsStore.getState().saveSettings(data.settings);
      }

      message.success(t('settings.importSuccess') || '导入成功，部分数据需要重启生效');
    } catch (e) {
      console.error('Import failed:', e);
      message.error(t('error.unknown') || '导入失败');
    }
  };

  const handleClear = async () => {
    try {
      const conversations = useConversationStore.getState().conversations;
      for (const conv of conversations) {
        await useConversationStore.getState().deleteConversation(conv.id);
      }
      message.success(t('settings.clearSuccess') || '数据已清除');
    } catch (e) {
      console.error('Clear failed:', e);
      message.error(t('error.unknown') || '清除失败');
    }
  };

  const rowStyle = { padding: '4px 0' };

  return (
    <div className="p-6 pb-12">
      <Card size="small" title={t('settings.groupData')} style={{ marginBottom: 16 }}>
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.exportData')}</span>
          <Button icon={<Share2 size={16} />} onClick={handleExport}>
            {t('settings.exportData')}
          </Button>
        </div>
        <Divider style={{ margin: '4px 0' }} />
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.importData')}</span>
          <Button icon={<Upload size={16} />} onClick={handleImport}>
            {t('settings.importData')}
          </Button>
        </div>
      </Card>
      <Card
        size="small"
        title={
          <Text type="danger">
            <AlertTriangle size={14} className="mr-2" />
            {t('settings.dangerZone')}
          </Text>
        }
      >
        <div style={rowStyle} className="flex items-center justify-between">
          <span>{t('settings.clearData')}</span>
          <Popconfirm
            title={t('settings.clearConfirm')}
            onConfirm={handleClear}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
          >
            <Button danger icon={<Trash2 size={16} />}>
              {t('settings.clearData')}
            </Button>
          </Popconfirm>
        </div>
      </Card>
    </div>
  );
}
