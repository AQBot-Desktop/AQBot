import { App } from 'antd';
import { fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import zhCN from '@/i18n/locales/zh-CN.json';
import enUS from '@/i18n/locales/en-US.json';
import ar from '@/i18n/locales/ar.json';
import type { useModelTestQueue } from '@/hooks/useModelTestQueue';
import { ModelTestPanel } from './ModelTestPanel';

vi.mock('@/lib/invoke', () => ({ isTauri: () => true, invoke: vi.fn() }));

type Queue = ReturnType<typeof useModelTestQueue>;
function queueFixture(overrides: Partial<Queue> = {}): Queue {
  const models: Queue['targetModels'] = [{
    provider_id: 'p1', model_id: 'model-1', name: 'Model', model_type: 'Chat',
    capabilities: ['TextChat'], enabled: true, context_window: null, param_overrides: null,
  }];
  return {
    config: { default_prompt: 'Say 1', max_prompt_chars: 2000, timeout_secs: 120, adapter_kinds: [] },
    configError: null, configLoading: false, reloadConfig: vi.fn().mockResolvedValue(undefined),
    execution: 'serial', setExecution: vi.fn(), supportedModels: models,
    panelOpen: true, panelMode: 'all', scope: 'all', setScope: vi.fn(), promptDraft: '',
    setPromptDraft: vi.fn(), promptDirty: false, promptTooLong: false, selectedModelId: '',
    setSelectedModelId: vi.fn(), targetModels: models, running: false, preparing: false,
    stopping: false, results: new Map(), activeIds: new Set(), firstTextTimes: new Map(),
    runningModelIds: new Set(), doneCount: 0, openPanel: vi.fn(), start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined), testInline: vi.fn().mockResolvedValue(undefined),
    restoreDefault: vi.fn(), closePanel: vi.fn(), savePrompt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
async function show(queue: Queue, locale = 'zh-CN') {
  const translations = locale === 'ar' ? ar : locale === 'en-US' ? enUS : zhCN;
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: translations } } });
  const view = render(<I18nextProvider i18n={i18n}><App><ModelTestPanel queue={queue} /></App></I18nextProvider>);
  return { ...view, t: i18n.t.bind(i18n) };
}

describe('model test panel', () => {
  it('offers parallel execution and a single-line input with the official default', async () => {
    const queue = queueFixture();
    const { t } = await show(queue);
    expect(screen.getByText(t('settings.modelTest.promptLabel')).closest('details')).not.toHaveAttribute('open');
    // jsdom does not implement native summary activation; browser QA covers clicks.
    screen.getByText(t('settings.modelTest.promptLabel')).closest('details')!.open = true;
    const input = screen.getByRole('textbox');
    expect(input.closest('details')).toHaveAttribute('open');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('placeholder', 'Say 1');
    expect(screen.getByRole('radio', { name: t('settings.modelTest.executionSerial') })).toBeChecked();
    expect(screen.getByRole('radio', { name: t('settings.modelTest.executionSerial') })).toHaveClass('ant-radio-input');
    fireEvent.click(screen.getByRole('radio', { name: t('settings.modelTest.executionParallel', { count: 3 }) }));
    expect(queue.setExecution).toHaveBeenCalledWith('parallel');
    screen.getByText(t('settings.modelTest.promptLabel')).closest('details')!.open = false;
    expect(input.closest('details')).not.toHaveAttribute('open');
  });
  it.each(['zh-CN', 'en-US', 'ar'])('renders localized results and escaped response details in %s', async (locale) => {
    const queue = queueFixture({ results: new Map([['model-1', {
      test_id: 'test', provider_id: 'p1', model_id: 'model-1', status: 'incomplete',
      first_text_ms: 123, total_ms: 456, checked_at: 0,
      response_preview: '<script>TEST_RESPONSE</script>', error_code: 'output_limit', error_detail: 'LOCAL_ENGLISH_ERROR',
    }]]) });
    const { t, baseElement } = await show(queue, locale);
    expect(screen.getByText(t('settings.modelTest.errors.output_limit'))).toBeInTheDocument();
    expect(screen.queryByText('LOCAL_ENGLISH_ERROR')).not.toBeInTheDocument();
    expect(screen.getByText(/TEST_RESPONSE/)).toHaveTextContent('<script>TEST_RESPONSE</script>');
    expect(baseElement.querySelector('script')).toBeNull();
    expect(screen.getByText(new RegExp(t('settings.modelTest.firstText')))).toHaveTextContent('0.12');
  });

  it('locks scope and prompt while running and routes close to cancellation', async () => {
    const queue = queueFixture({ running: true, runningModelIds: new Set(['model-1']), activeIds: new Set(['model-1']), firstTextTimes: new Map([['model-1', 42]]) });
    const { t } = await show(queue);
    // jsdom does not implement native summary activation; browser QA covers clicks.
    screen.getByText(t('settings.modelTest.promptLabel')).closest('details')!.open = true;
    expect(screen.getByRole('textbox')).toBeDisabled();
    screen.getAllByRole('radio').forEach((radio) => expect(radio).toBeDisabled());
    expect(screen.getByText(t('settings.modelTest.status.running'))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(t('settings.modelTest.firstText')))).toHaveTextContent('0.04');
    fireEvent.click(screen.getByRole('button', { name: t('settings.modelTest.stop') }));
    expect(queue.stop).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: t('common.close') }));
    expect(queue.closePanel).toHaveBeenCalledOnce();
  });

  it('disables execution on configuration failure and exposes retry', async () => {
    const queue = queueFixture({ config: null, configError: 'offline' });
    const { t } = await show(queue);
    expect(screen.getByRole('button', { name: t('settings.modelTest.start') })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: t('settings.modelTest.retry') }));
    expect(queue.reloadConfig).toHaveBeenCalledOnce();
  });

  it('shows validation and cannot start an overlong prompt', async () => {
    const queue = queueFixture({ promptTooLong: true, promptDirty: true, promptDraft: '😀'.repeat(2001) });
    const { t } = await show(queue);
    // jsdom does not implement native summary activation; browser QA covers clicks.
    screen.getByText(t('settings.modelTest.promptLabel')).closest('details')!.open = true;
    expect(screen.getByRole('textbox')).toHaveValue('😀'.repeat(2001));
    expect(screen.getByText(t('settings.modelTest.promptTooLong', { count: 2000 }))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('settings.modelTest.saveAndTest') })).toBeDisabled();
  });
});
