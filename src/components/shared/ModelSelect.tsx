import { useMemo, useCallback } from 'react';
import { Select, theme } from 'antd';
import { ModelIcon } from '@lobehub/icons';
import { useProviderStore } from '@/stores';

/** Parse a combined `providerId::modelId` value. */
export function parseModelValue(value: string | undefined) {
  if (!value) return null;
  const idx = value.indexOf('::');
  if (idx < 0) return null;
  return { providerId: value.slice(0, idx), modelId: value.slice(idx + 2) };
}

/** Hook: returns grouped Select options (Provider → Models) */
export function useGroupedModelOptions() {
  const providers = useProviderStore((s) => s.providers);
  return useMemo(() => {
    return providers
      .filter((p) => p.enabled && p.models.some((m) => m.enabled))
      .map((p) => ({
        label: (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ModelIcon model={p.name} size={16} type="avatar" />
            {p.name}
          </span>
        ),
        title: p.name,
        options: p.models
          .filter((m) => m.enabled)
          .map((m) => ({
            label: m.name,
            value: `${p.id}::${m.model_id}`,
            modelId: m.model_id,
            providerName: p.name,
          })),
      }));
  }, [providers]);
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
 * Reusable model selector with provider-grouped options, ModelIcon rendering,
 * and search support. Value format: `providerId::modelId`.
 */
export function ModelSelect({
  value,
  onChange,
  placeholder,
  allowClear = true,
  style,
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  allowClear?: boolean;
  style?: React.CSSProperties;
}) {
  const { token } = theme.useToken();
  const groupedOptions = useGroupedModelOptions();
  const providerNameMap = useProviderNameMap();

  const optionRender = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (option: any) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <ModelIcon model={option.data?.modelId ?? ''} size={18} type="avatar" />
        {option.label}
      </span>
    ),
    [],
  );

  const labelRender = useCallback(
    (props: { label?: React.ReactNode; value?: string | number }) => {
      const parsed = parseModelValue(String(props.value ?? ''));
      if (!parsed) return <span>{props.label}</span>;
      const providerName = providerNameMap.get(parsed.providerId) ?? '';
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ModelIcon model={parsed.modelId} size={18} type="avatar" />
          {props.label}
          <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
            ({providerName})
          </span>
        </span>
      );
    },
    [providerNameMap, token.colorTextSecondary],
  );

  return (
    <Select
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
