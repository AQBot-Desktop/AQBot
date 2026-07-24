import { Alert, Checkbox, Modal, Spin, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  Model,
  ModelCapability,
  ModelMetadataSource,
  ModelMetadataState,
  ModelType,
} from '@/types';

const { Text } = Typography;

export const MODEL_METADATA_FIELDS = [
  'model_type',
  'capabilities',
  'context_window',
  'max_output_tokens',
  'no_system_role',
  'omit_sampling_params',
  'reasoning_options',
] as const;

export type ModelMetadataField = (typeof MODEL_METADATA_FIELDS)[number];

interface MetadataSyncRow {
  field: ModelMetadataField;
  current: unknown;
  inferred: unknown;
  source: ModelMetadataSource | null;
  available: boolean;
  changed: boolean;
}

interface ModelMetadataSyncModalProps {
  open: boolean;
  loading: boolean;
  currentModel: Model | null;
  inferredModel: Model | null;
  unsupportedReason?: string | null;
  onCancel: () => void;
  onApply: (fields: ModelMetadataField[]) => void;
}

function metadataValue(model: Model, field: ModelMetadataField): unknown {
  switch (field) {
    case 'model_type':
      return model.model_type;
    case 'capabilities':
      return model.capabilities;
    case 'context_window':
      return model.context_window;
    case 'max_output_tokens':
      return model.max_output_tokens ?? null;
    case 'no_system_role':
      return model.param_overrides?.no_system_role ?? null;
    case 'omit_sampling_params':
      return model.param_overrides?.omit_sampling_params ?? null;
    case 'reasoning_options':
      return model.param_overrides?.reasoning_options ?? null;
  }
}

function normalizedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...new Set(value.map(String))].sort();
  }
  return value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizedValue(left)) === JSON.stringify(normalizedValue(right));
}

function fieldSource(
  metadata: ModelMetadataState | null | undefined,
  field: ModelMetadataField,
): ModelMetadataSource | null {
  return metadata?.[field] ?? null;
}

function sourceProvidesValue(
  field: ModelMetadataField,
  source: ModelMetadataSource | null,
): boolean {
  if (source === 'catalog' || source === 'provider' || source === 'heuristic') {
    return true;
  }
  return source === 'default' && (field === 'model_type' || field === 'capabilities');
}

export function buildMetadataSyncRows(
  currentModel: Model,
  inferredModel: Model,
): MetadataSyncRow[] {
  return MODEL_METADATA_FIELDS.map((field) => {
    const current = metadataValue(currentModel, field);
    const inferred = metadataValue(inferredModel, field);
    const source = fieldSource(inferredModel.metadata_state, field);
    const available = sourceProvidesValue(field, source);
    return {
      field,
      current,
      inferred,
      source,
      available,
      changed: available && !valuesEqual(current, inferred),
    };
  });
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return value.toLocaleString();
}

export function ModelMetadataSyncModal({
  open,
  loading,
  currentModel,
  inferredModel,
  unsupportedReason,
  onCancel,
  onApply,
}: ModelMetadataSyncModalProps) {
  const { t } = useTranslation();
  const rows = useMemo(
    () => currentModel && inferredModel
      ? buildMetadataSyncRows(currentModel, inferredModel)
      : [],
    [currentModel, inferredModel],
  );
  const [selected, setSelected] = useState<Set<ModelMetadataField>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(rows.filter((row) => row.changed).map((row) => row.field)));
  }, [open, rows]);

  const formatValue = (field: ModelMetadataField, value: unknown) => {
    if (value == null) return t('settings.metadataUnknown');
    if (field === 'model_type') {
      return t(`settings.modelType.${value as ModelType}`, String(value));
    }
    if (field === 'capabilities') {
      const capabilities = value as ModelCapability[];
      return capabilities.length > 0
        ? capabilities.map((capability) =>
            t(`settings.capability.${capability}`, capability)).join(', ')
        : t('common.none');
    }
    if (field === 'reasoning_options') {
      const options = value as string[];
      return options.length > 0 ? options.join(', ') : t('common.none');
    }
    if (field === 'context_window' || field === 'max_output_tokens') {
      return formatTokens(value as number);
    }
    return t(value ? 'common.enabled' : 'common.disabled');
  };

  return (
    <Modal
      title={t('settings.syncModelMetadata')}
      open={open}
      mask={{ enabled: true, blur: true }}
      onCancel={onCancel}
      onOk={() => onApply(Array.from(selected))}
      okText={t('settings.syncSelectedMetadata')}
      cancelText={t('common.cancel')}
      okButtonProps={{
        disabled: loading || Boolean(unsupportedReason) || selected.size === 0,
      }}
      width={680}
      destroyOnHidden
    >
      <Text type="secondary">{t('settings.syncModelMetadataHint')}</Text>
      {unsupportedReason && (
        <Alert
          type="error"
          showIcon
          message={unsupportedReason}
          style={{ marginTop: 12 }}
        />
      )}
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spin />
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '32px minmax(120px, 1fr) minmax(120px, 1fr) 24px minmax(120px, 1fr)',
              gap: 8,
              padding: '0 8px 8px',
              color: 'var(--ant-color-text-secondary)',
              fontSize: 12,
            }}
          >
            <span />
            <span>{t('settings.metadataField')}</span>
            <span>{t('settings.metadataCurrentValue')}</span>
            <span />
            <span>{t('settings.metadataInferredValue')}</span>
          </div>
          {rows.map((row) => {
            const disabled = Boolean(unsupportedReason) || !row.available;
            return (
              <div
                key={row.field}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '32px minmax(120px, 1fr) minmax(120px, 1fr) 24px minmax(120px, 1fr)',
                  gap: 8,
                  alignItems: 'center',
                  padding: '11px 8px',
                  borderTop: '1px solid var(--ant-color-border-secondary)',
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                <Checkbox
                  aria-label={t(`settings.metadataSyncField.${row.field}`)}
                  checked={selected.has(row.field)}
                  disabled={disabled}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(row.field);
                      else next.delete(row.field);
                      return next;
                    });
                  }}
                />
                <Text strong>{t(`settings.metadataSyncField.${row.field}`)}</Text>
                <Text>{formatValue(row.field, row.current)}</Text>
                <Text type="secondary">→</Text>
                <Text type={row.available ? undefined : 'secondary'}>
                  {row.available
                    ? formatValue(row.field, row.inferred)
                    : t('settings.metadataNoCatalogData')}
                </Text>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
