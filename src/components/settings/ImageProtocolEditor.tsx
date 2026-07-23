import { Alert, Checkbox, Form, Input, InputNumber, Select, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImageAdapterConfig, ProviderType } from '@/types';

interface Props {
  value: ImageAdapterConfig | null | undefined;
  providerType: ProviderType;
  modelId: string;
  onChange: (value: ImageAdapterConfig | null) => void;
}

export function ImageProtocolEditor({
  value,
  providerType,
  modelId,
  onChange,
}: Props) {
  const { t } = useTranslation();
  const config = value ?? {};
  const [mappingText, setMappingText] = useState(formatJson(config.mapping));
  const [extraBodyText, setExtraBodyText] = useState(formatJson(config.extra_body));
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    setMappingText(formatJson(config.mapping));
    setExtraBodyText(formatJson(config.extra_body));
    setJsonError(null);
  }, [value]);

  const patch = (next: Partial<ImageAdapterConfig>) => {
    onChange({ ...config, ...next });
  };

  const commitJson = (field: 'mapping' | 'extra_body', text: string) => {
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      setJsonError(t('imageProtocol.invalidJson', '图片协议 JSON 无效'));
      return;
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      setJsonError(t('imageProtocol.jsonObjectRequired', '必须是 JSON 对象'));
      return;
    }
    setJsonError(null);
    patch({ [field]: parsed });
  };

  return (
    <div className="space-y-3">
      <div>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('imageProtocol.title', '图片协议')}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {providerType === 'custom' && modelId.startsWith('grok-imagine')
            ? t(
              'imageProtocol.grokAutoDetectDescription',
              '当前模型默认识别为 xAI Images，可在下方显式覆盖。',
            )
            : t(
              'imageProtocol.autoDetectDescription',
              '自动识别会根据服务商类型和模型 ID 选择内置适配器。',
            )}
        </Typography.Text>
      </div>

      <Form layout="vertical" size="small">
        <Form.Item label={t('imageProtocol.adapterProfile', '适配器预设')}>
          <Select
            value={config.adapter_id ?? ''}
            options={[
              { value: '', label: t('imageProtocol.autoDetect', '自动识别') },
              { value: 'openai_images', label: 'OpenAI Images' },
              { value: 'xai_images', label: 'xAI Images' },
              { value: 'glm_images', label: 'GLM / CogView' },
              { value: 'siliconflow_images', label: 'SiliconFlow Images' },
              { value: 'gemini_images', label: 'Gemini / Nano Banana' },
              { value: 'generic_json', label: 'Generic JSON' },
            ]}
            onChange={(adapterId) => patch({ adapter_id: adapterId || null })}
          />
        </Form.Item>
        <Form.Item
          label={t(
            'imageProtocol.capabilityOverrides',
            '能力覆盖（留空使用适配器预设值）',
          )}
        >
          <Checkbox.Group
            value={config.operation_overrides ?? []}
            options={[
              { value: 'generate', label: t('imageProtocol.operation.generate', '生成') },
              { value: 'edit', label: t('imageProtocol.operation.edit', '编辑') },
              { value: 'mask_edit', label: t('imageProtocol.operation.maskEdit', '区域编辑') },
            ]}
            onChange={(operations) => patch({
              operation_overrides: operations.length > 0
                ? operations as ImageAdapterConfig['operation_overrides']
                : null,
            })}
          />
        </Form.Item>
        <Form.Item label={t('imageProtocol.generationEndpoint', '生成端点')}>
          <Input
            value={config.endpoint ?? ''}
            placeholder={t(
              'imageProtocol.generationEndpointPlaceholder',
              '/images/generations 或完整 URL',
            )}
            onChange={(event) => patch({ endpoint: event.target.value || null })}
          />
        </Form.Item>
        <Form.Item label={t('imageProtocol.editEndpoint', '编辑端点')}>
          <Input
            value={config.edit_endpoint ?? ''}
            placeholder="/images/edits"
            onChange={(event) => patch({ edit_endpoint: event.target.value || null })}
          />
        </Form.Item>
        <Form.Item label={t('imageProtocol.pollEndpoint', '轮询端点')}>
          <Input
            value={config.poll_endpoint ?? ''}
            placeholder="/tasks/{task_id}"
            onChange={(event) => patch({ poll_endpoint: event.target.value || null })}
          />
        </Form.Item>
        <Form.Item label={t('imageProtocol.cancelEndpoint', '取消端点')}>
          <Input
            value={config.cancel_endpoint ?? ''}
            placeholder="/tasks/{task_id}/cancel"
            onChange={(event) => patch({ cancel_endpoint: event.target.value || null })}
          />
        </Form.Item>
        <Form.Item label={t('imageProtocol.authMode', '认证方式')}>
          <Select
            value={config.auth_mode ?? 'bearer'}
            options={[
              { value: 'bearer', label: t('imageProtocol.auth.bearer', 'Bearer Token') },
              {
                value: 'api_key_header',
                label: t('imageProtocol.auth.apiKeyHeader', 'API 密钥 Header'),
              },
              { value: 'query', label: t('imageProtocol.auth.query', '查询参数') },
              { value: 'none', label: t('imageProtocol.auth.none', '无认证') },
            ]}
            onChange={(authMode) => patch({ auth_mode: authMode })}
          />
        </Form.Item>
        {config.auth_mode === 'api_key_header' && (
          <Form.Item label={t('imageProtocol.authHeaderName', '认证 Header 名称')}>
            <Input
              value={config.auth_header ?? ''}
              placeholder="x-api-key"
              onChange={(event) => patch({ auth_header: event.target.value || null })}
            />
          </Form.Item>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Form.Item label={t('imageProtocol.pollIntervalSeconds', '轮询间隔（秒）')}>
            <InputNumber
              min={1}
              max={30}
              value={config.poll_interval_secs ?? 3}
              style={{ width: '100%' }}
              onChange={(next) => patch({ poll_interval_secs: next ?? 3 })}
            />
          </Form.Item>
          <Form.Item label={t('imageProtocol.timeoutSeconds', '总时限（秒）')}>
            <InputNumber
              min={60}
              max={86400}
              value={config.timeout_secs ?? 3600}
              style={{ width: '100%' }}
              onChange={(next) => patch({ timeout_secs: next ?? 3600 })}
            />
          </Form.Item>
        </div>
        <Form.Item label={t('imageProtocol.extraBody', '附加请求体（JSON 对象）')}>
          <Input.TextArea
            value={extraBodyText}
            autoSize={{ minRows: 2, maxRows: 6 }}
            onChange={(event) => setExtraBodyText(event.target.value)}
            onBlur={() => commitJson('extra_body', extraBodyText)}
          />
        </Form.Item>
        {config.adapter_id === 'generic_json' && (
          <Form.Item
            label={t(
              'imageProtocol.fieldResponseMapping',
              '字段与响应映射（JSON 对象）',
            )}
          >
            <Input.TextArea
              value={mappingText}
              autoSize={{ minRows: 5, maxRows: 12 }}
              onChange={(event) => setMappingText(event.target.value)}
              onBlur={() => commitJson('mapping', mappingText)}
              placeholder={'{"request_fields":{"prompt":"input.text"},"images_path":"/data"}'}
            />
          </Form.Item>
        )}
      </Form>
      {jsonError && (
        <Alert
          type="error"
          showIcon
          title={t('imageProtocol.invalidJson', '图片协议 JSON 无效')}
          description={jsonError}
        />
      )}
    </div>
  );
}

function formatJson(value: unknown): string {
  if (!value || typeof value !== 'object') return '{}';
  return JSON.stringify(value, null, 2);
}
