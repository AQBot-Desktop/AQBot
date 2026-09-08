import { useId } from 'react';
import { Alert, Button, Empty, Form, Input, Modal, Progress, Radio, Select, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@/lib/invoke';
import { MODEL_TEST_PARALLEL_LIMIT, type useModelTestQueue } from '@/hooks/useModelTestQueue';
import { ModelTestResult } from './ModelTestResult';

interface Props {
  queue: ReturnType<typeof useModelTestQueue>;
}

export function ModelTestPanel({ queue }: Props) {
  const { t } = useTranslation();
  const radioGroupId = useId();
  const models = queue.targetModels;
  const busy = queue.running || queue.preparing;
  const completed = models.filter((model) => queue.results.has(model.model_id)).length;
  const unavailable = !isTauri() || !queue.config || queue.configLoading;
  const invalidPrompt = queue.promptTooLong;

  return <Modal
    title={t('settings.modelTest.panelTitle')}
    open={queue.panelOpen}
    onCancel={queue.closePanel}
    width={680}
    footer={<Space wrap>
      <Button aria-label={t('common.close')} onClick={queue.closePanel}>{t('common.close')}</Button>
      {queue.running ? <Button danger onClick={() => { void queue.stop(); }}>
        {t(queue.stopping ? 'settings.modelTest.stopping' : 'settings.modelTest.stop')}
      </Button> : <Button type="primary" loading={queue.preparing || queue.configLoading}
        disabled={unavailable || invalidPrompt || models.length === 0}
        onClick={() => { void queue.start(); }}>
        {t(queue.promptDirty ? 'settings.modelTest.saveAndTest' : 'settings.modelTest.start')}
      </Button>}
    </Space>}
  >
    {!isTauri() && <Alert type="info" showIcon title={t('settings.modelTest.browserDisabled')} />}
    {queue.configError && <Alert type="error" showIcon title={t('settings.modelTest.configError')}
      action={<Button size="small" aria-label={t('settings.modelTest.retry')} onClick={() => { void queue.reloadConfig(); }}>{t('settings.modelTest.retry')}</Button>} />}
    <Form layout="vertical" style={{ marginTop: 16 }}>
      {queue.panelMode === 'single' && <Form.Item label={t('settings.selectModel')}>
        <Select showSearch disabled={busy} aria-label={t('settings.selectModel')}
          value={queue.selectedModelId || undefined} onChange={queue.setSelectedModelId}
          placeholder={t('settings.selectModel')} optionFilterProp="label"
          options={queue.supportedModels.map((model) => ({ label: model.name || model.model_id, value: model.model_id }))} />
      </Form.Item>}
      {queue.panelMode !== 'single' && <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 24 }}>
        <Form.Item label={t('settings.modelTest.executionLabel')} style={{ flex: '1 1 260px' }}>
          <Radio.Group name={`${radioGroupId}-execution`} value={queue.execution} disabled={busy}
            onChange={(event) => queue.setExecution(event.target.value)}
            options={[
              { value: 'serial', label: t('settings.modelTest.executionSerial') },
              { value: 'parallel', label: t('settings.modelTest.executionParallel', { count: MODEL_TEST_PARALLEL_LIMIT }) },
            ]} />
        </Form.Item>
        <Form.Item label={t('settings.modelTest.scopeLabel')} style={{ flex: '1 1 260px' }}>
          <Radio.Group name={`${radioGroupId}-scope`} value={queue.scope} disabled={busy}
            onChange={(event) => queue.setScope(event.target.value)}
            options={[
              { value: 'all', label: t('settings.modelTest.scopeAll') },
              { value: 'enabled', label: t('settings.modelTest.scopeEnabled') },
            ]} />
        </Form.Item>
      </div>}
      <details style={{ marginBottom: 16 }}>
        <summary style={{ cursor: 'pointer' }}>{t('settings.modelTest.promptLabel')}</summary>
        <Form.Item style={{ marginTop: 12, marginBottom: 0 }} validateStatus={invalidPrompt ? 'error' : undefined}
          help={invalidPrompt ? t('settings.modelTest.promptTooLong', { count: queue.config?.max_prompt_chars ?? 2000 }) : t('settings.modelTest.promptHint')}>
          <Input value={queue.promptDraft} disabled={busy}
            onChange={(event) => queue.setPromptDraft(event.target.value)}
            placeholder={queue.config?.default_prompt}
            count={{ show: true, max: queue.config?.max_prompt_chars ?? 2000, strategy: (value) => [...value].length }}
            aria-label={t('settings.modelTest.promptLabel')} />
          <Button type="link" disabled={busy || unavailable} onClick={queue.restoreDefault} style={{ paddingLeft: 0 }}>
            {t('settings.modelTest.restoreDefault')}
          </Button>
          <Button type="link" disabled={busy || unavailable || invalidPrompt || !queue.promptDirty}
            onClick={() => { void queue.savePrompt(); }}>{t('settings.modelTest.savePrompt')}</Button>
        </Form.Item>
      </details>
    </Form>
    {queue.config && <Typography.Paragraph style={{ marginBottom: 4 }}>
      {t('settings.modelTest.requestCount', { count: models.length })}
    </Typography.Paragraph>}
    <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
      {t('settings.modelTest.usageHint')}
    </Typography.Paragraph>
    {queue.preparing && <Typography.Text role="status">{t('settings.modelTest.preparing')}</Typography.Text>}
    {models.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.noMatchingModels')} /> : <>
      <div role="status" aria-live="polite">{t('settings.modelTest.progress', { done: completed, total: models.length })}</div>
      <Progress percent={Math.round(completed / models.length * 100)} showInfo={false} size="small"
        aria-label={t('settings.modelTest.progress', { done: completed, total: models.length })} />
      <div style={{ maxHeight: 340, overflow: 'auto', marginTop: 8 }}>
        {models.map((model) => {
          const result = queue.results.get(model.model_id);
          const status = queue.runningModelIds.has(model.model_id) ? 'running'
            : queue.activeIds.has(model.model_id) ? 'queued' : result?.status ?? 'idle';
          return <div key={model.model_id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-color)' }}>
            <Typography.Text strong style={{ overflowWrap: 'anywhere' }}>{model.name || model.model_id}</Typography.Text>
            {model.name && model.name !== model.model_id && <Typography.Text type="secondary" style={{ marginInlineStart: 8, fontSize: 12, overflowWrap: 'anywhere' }}>{model.model_id}</Typography.Text>}
            <ModelTestResult result={result} status={status} firstTextMs={queue.firstTextTimes.get(model.model_id)} />
          </div>;
        })}
      </div>
    </>}
  </Modal>;
}
