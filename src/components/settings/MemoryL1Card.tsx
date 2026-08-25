import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Input, Switch, Typography, message, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { getContextErrorMessage } from '@/lib/contextErrorMessage';
import { useMemoryStore } from '@/stores';

export const MEMORY_L1_MAX_BYTES = 5000;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function MemoryL1Card({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [messageApi, contextHolder] = message.useMessage();
  const l1 = useMemoryStore((s) => s.l1);
  const saveL1 = useMemoryStore((s) => s.saveL1);
  const setL1Enabled = useMemoryStore((s) => s.setL1Enabled);
  const [markdown, setMarkdown] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const bytes = useMemo(() => utf8ByteLength(markdown), [markdown]);
  const overLimit = bytes > MEMORY_L1_MAX_BYTES;

  const load = useCallback(async () => {
    try {
      await useMemoryStore.getState().ensureL1Loaded();
      setLoadError(null);
    } catch (error) {
      setLoadError(getContextErrorMessage(error, t));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!l1 || dirty) return;
    setMarkdown(l1.markdown);
  }, [l1, dirty]);

  const handleSave = async () => {
    if (!l1 || overLimit) return;
    setSaving(true);
    try {
      const saved = await saveL1({ enabled: l1.enabled, markdown, revision: l1.revision });
      setMarkdown(saved.markdown);
      setDirty(false);
      messageApi.success(t('settings.memory.l1.saveSuccess'));
    } catch (error) {
      const coded = getContextErrorMessage(error, t);
      messageApi.error(coded);
      if (String(error).includes('MEMORY_L1_REVISION_CONFLICT')) {
        setDirty(false);
        await load();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setMarkdown(text);
    setDirty(true);
    setPreview(false);
  };

  const handleExport = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'aqbot-memory-l1.md';
    link.click();
    URL.revokeObjectURL(url);
  };

  const editor = (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        {t('settings.memory.l1.description')}
      </Typography.Paragraph>
      {loadError ? <Alert type="error" showIcon message={loadError} style={{ marginBottom: 12 }} /> : null}
      <div className="flex items-center gap-2 mb-2">
        <Button size="small" onClick={() => setPreview((value) => !value)}>
          {preview ? t('settings.memory.l1.edit') : t('settings.memory.l1.preview')}
        </Button>
        <Button size="small" onClick={() => document.getElementById('memory-l1-import')?.click()}>
          {t('settings.memory.l1.import')}
        </Button>
        <input
          id="memory-l1-import"
          type="file"
          accept=".md,text/markdown,text/plain"
          hidden
          aria-label={t('settings.memory.l1.import')}
          onChange={(event) => {
            void handleImport(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <Button size="small" onClick={handleExport}>
          {t('settings.memory.l1.export')}
        </Button>
        <span style={{ marginLeft: 'auto', color: overLimit ? token.colorError : token.colorTextSecondary }}>
          {t('settings.memory.l1.byteCount', { bytes, limit: MEMORY_L1_MAX_BYTES })}
        </span>
      </div>
      {preview ? (
        <div
          aria-label={t('settings.memory.l1.preview')}
          style={{
            minHeight: 160,
            whiteSpace: 'pre-wrap',
            padding: 12,
            border: `1px solid ${token.colorBorder}`,
            borderRadius: token.borderRadius,
            background: token.colorFillAlter,
          }}
        >
          {markdown.trim() ? markdown : t('settings.memory.l1.emptyPreview')}
        </div>
      ) : (
        <Input.TextArea
          aria-label={t('settings.memory.l1.ariaLabel')}
          value={markdown}
          onChange={(event) => {
            setMarkdown(event.target.value);
            setDirty(true);
          }}
          placeholder={t('settings.memory.l1.placeholder')}
          autoSize={{ minRows: 6, maxRows: 16 }}
        />
      )}
      <div className="flex justify-end mt-3">
        <Button type="primary" onClick={() => void handleSave()} loading={saving} disabled={!l1 || overLimit}>
          {t('settings.memory.l1.save')}
        </Button>
      </div>
    </>
  );

  const enabledSwitch = (
    <Switch
      checked={l1?.enabled ?? true}
      onChange={(checked) => {
        void setL1Enabled(checked);
      }}
      aria-label={t('settings.memory.l1.enabled')}
    />
  );

  if (embedded) {
    return (
      <div className="p-6 pb-12 overflow-y-auto h-full">
        <div className="flex items-center justify-between mb-4">
          <span style={{ fontWeight: 600, fontSize: 16 }}>{t('settings.memory.l1.title')}</span>
          {enabledSwitch}
        </div>
        {editor}
      </div>
    );
  }

  return (
    <Card
      size="small"
      style={{ margin: 16, marginBottom: 0 }}
      title={t('settings.memory.l1.title')}
      extra={enabledSwitch}
    >
      {editor}
    </Card>
  );
}
