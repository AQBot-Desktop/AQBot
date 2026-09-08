import { Button, Popover, Space, Tag, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ModelTestResult as TestResult } from '@/types';
import type { ModelTestUiStatus } from '@/hooks/useModelTestQueue';

const STATUS_KEYS: Record<ModelTestUiStatus, string> = {
  passed: 'settings.modelTest.status.passed', incomplete: 'settings.modelTest.status.incomplete',
  failed: 'settings.modelTest.status.failed', timeout: 'settings.modelTest.status.timeout',
  cancelled: 'settings.modelTest.status.cancelled', unsupported: 'settings.modelTest.status.unsupported',
  queued: 'settings.modelTest.status.queued', running: 'settings.modelTest.status.running',
  idle: 'settings.modelTest.status.idle',
};

const ERROR_KEYS: Record<string, string> = {
  invalid_prompt: 'settings.modelTest.errors.invalid_prompt',
  invalid_reasoning: 'settings.modelTest.errors.invalid_reasoning',
  model_not_found: 'settings.modelTest.errors.model_not_found',
  no_active_key: 'settings.modelTest.errors.no_active_key',
  output_limit: 'settings.modelTest.errors.output_limit',
  tool_calls: 'settings.modelTest.errors.tool_calls',
  content_filter: 'settings.modelTest.errors.content_filter',
  empty_result: 'settings.modelTest.errors.empty_result',
  incomplete_stream: 'settings.modelTest.errors.incomplete_stream',
  unknown_finish_reason: 'settings.modelTest.errors.unknown_finish_reason',
  thinking_only: 'settings.modelTest.errors.thinking_only',
  already_running: 'settings.modelTest.errors.already_running',
};

interface Props {
  result?: TestResult;
  status?: ModelTestUiStatus;
  firstTextMs?: number;
  compact?: boolean;
}

export function ModelTestResult({ result, status = result?.status ?? 'idle', firstTextMs, compact }: Props) {
  const { t } = useTranslation();
  const first = firstTextMs ?? result?.first_text_ms;
  const total = result?.total_ms;
  const color = status === 'passed' ? 'success' : status === 'incomplete' ? 'warning'
    : status === 'failed' || status === 'timeout' ? 'error'
      : status === 'running' || status === 'queued' ? 'processing' : 'default';
  const localErrorKey = result?.error_code && Object.prototype.hasOwnProperty.call(ERROR_KEYS, result.error_code)
    ? ERROR_KEYS[result.error_code] : undefined;
  const error = localErrorKey ? t(localErrorKey) : result?.error_detail;
  const summary = (
    <Space size={4} wrap>
      <Tag color={color} variant="filled" style={{ margin: 0 }}>{t(STATUS_KEYS[status])}</Tag>
      <Tooltip title={t('settings.modelTest.timingHint')}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {first != null && <>{t('settings.modelTest.firstText')} {t('settings.modelTest.seconds', { value: (first / 1000).toFixed(2) })}</>}
          {first != null && total != null && ' · '}
          {total != null && <>{t(status === 'failed' || status === 'timeout' ? 'settings.modelTest.failureTime' : 'settings.modelTest.totalTime')} {t('settings.modelTest.seconds', { value: (total / 1000).toFixed(2) })}</>}
        </Typography.Text>
      </Tooltip>
    </Space>
  );
  const details = (
    <div style={{ maxWidth: 460, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', fontSize: 12 }}>
      {error && <div style={{ marginTop: 4 }}>{error}</div>}
      {result?.response_preview && <div style={{ marginTop: 4, maxHeight: 100, overflow: 'auto' }}>
        <Typography.Text type="secondary">{t('settings.modelTest.responsePreview')}: </Typography.Text>
        {result.response_preview}
      </div>}
    </div>
  );
  if (compact && (error || result?.response_preview)) {
    return <Popover content={details} trigger="click">
      <Button type="text" size="small" style={{ height: 'auto', padding: '2px 4px' }}>{summary}</Button>
    </Popover>;
  }
  return <div>{summary}{!compact && details}</div>;
}
