import { useMemo, useCallback, type CSSProperties, type ReactNode } from 'react';
import { Select } from 'antd';
import { ModelIcon } from '@lobehub/icons';
import { useProviderStore } from '@/stores';
import { SmartProviderIcon } from '@/lib/providerIcons';
import type { ModelCapability, ModelType } from '@/types';

/** Class applied to every model Select for shared alignment / open-state styles. */
export const MODEL_SELECT_CLASS = 'aqbot-model-select';

/** Parse a combined `providerId::modelId` value. */
export function parseModelValue(value: string | undefined) {
  if (!value) return null;
  const idx = value.indexOf('::');
  if (idx < 0) return null;
  return { providerId: value.slice(0, idx), modelId: value.slice(idx + 2) };
}

/** Hook: returns grouped Select options (Provider → Models) */
export function useGroupedModelOptions(modelType?: ModelType, requiredCapability?: ModelCapability) {
  const providers = useProviderStore((s) => s.providers);
  return useMemo(() => {
    return providers
      .filter((p) => p.enabled)
      .map((p) => {
        const models = p.models.filter((m) => (
          m.enabled
          && (!modelType || m.model_type === modelType)
          && (!requiredCapability || m.capabilities.includes(requiredCapability))
        ));
        if (models.length === 0) return null;
        return {
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <SmartProviderIcon provider={p} size={16} type="avatar" />
              {p.name}
            </span>
          ),
          title: p.name,
          options: models.map((m) => ({
            label: m.name,
            value: `${p.id}::${m.model_id}`,
            modelId: m.model_id,
            providerName: p.name,
          })),
        };
      })
      .filter((option): option is NonNullable<typeof option> => option !== null);
  }, [providers, modelType, requiredCapability]);
}

/** Hook: returns Map<providerId, providerName> */
export function useProviderNameMap() {
  const providers = useProviderStore((s) => s.providers);
  return useMemo(() => {
    const map = new Map<string, string>();
    providers.forEach((p) => map.set(p.id, p.name));
    return map;
  }, [providers]);
}

/**
 * Selected-value label: icon + name + optional (provider).
 * Provider name uses opacity (not a fixed color) so antd open-state graying inherits correctly.
 */
export function ModelSelectValueLabel({
  modelId,
  label,
  providerName,
}: {
  modelId: string;
  label: ReactNode;
  providerName?: string;
}) {
  return (
    <span className="aqbot-model-select-label">
      <span className="aqbot-model-select-icon" aria-hidden>
        <ModelIcon model={modelId} size={16} type="avatar" />
      </span>
      <span className="aqbot-model-select-name">{label}</span>
      {providerName ? (
        <span className="aqbot-model-select-provider">({providerName})</span>
      ) : null}
    </span>
  );
}

/** Shared option renderer for model dropdown rows. */
export function useModelSelectOptionRender() {
  return useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (option: any) => (
      <span className="aqbot-model-select-option">
        <span className="aqbot-model-select-icon" aria-hidden>
          <ModelIcon model={option.data?.modelId ?? ''} size={16} type="avatar" />
        </span>
        {option.label}
      </span>
    ),
    [],
  );
}

/** Shared labelRender for selected value (`providerId::modelId`). */
export function useModelSelectLabelRender(providerNameMap: Map<string, string>) {
  return useCallback(
    (props: { label?: ReactNode; value?: string | number }) => {
      const parsed = parseModelValue(String(props.value ?? ''));
      if (!parsed) return <span>{props.label}</span>;
      const providerName = providerNameMap.get(parsed.providerId) ?? '';
      return (
        <ModelSelectValueLabel
          modelId={parsed.modelId}
          label={props.label}
          providerName={providerName}
        />
      );
    },
    [providerNameMap],
  );
}

/**
 * Reusable model selector with provider-grouped options, ModelIcon rendering,
 * and search support. Value format: `providerId::modelId`.
 */
export function ModelSelect({
  value,
  onChange,
  placeholder,
  allowClear = true,
  style,
  modelType,
  className,
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  allowClear?: boolean;
  style?: CSSProperties;
  modelType?: ModelType;
  className?: string;
}) {
  const groupedOptions = useGroupedModelOptions(modelType);
  const providerNameMap = useProviderNameMap();
  const optionRender = useModelSelectOptionRender();
  const labelRender = useModelSelectLabelRender(providerNameMap);

  return (
    <Select
      className={[MODEL_SELECT_CLASS, className].filter(Boolean).join(' ')}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      allowClear={allowClear}
      showSearch
      optionFilterProp="label"
      optionRender={optionRender}
      labelRender={labelRender}
      options={groupedOptions}
      style={style}
    />
  );
}
