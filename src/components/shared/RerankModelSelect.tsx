import { useMemo, useCallback, useEffect } from 'react';
import { Select, theme } from 'antd';
import { ModelIcon } from '@lobehub/icons';
import { useProviderStore } from '@/stores';
import { parseModelValue, useProviderNameMap } from './ModelSelect';

function isRerankModel(model: { model_id: string; model_type?: string }) {
  return model.model_type === 'Rerank' || /rerank|colbert/i.test(model.model_id);
}

function useRerankModelOptions() {
  const providers = useProviderStore((s) => s.providers);
  const fetchProviders = useProviderStore((s) => s.fetchProviders);

  useEffect(() => {
    if (providers.length === 0) {
      void fetchProviders();
    }
  }, [fetchProviders, providers.length]);

  return useMemo(() => {
    return providers
      .filter((p) => p.enabled)
      .map((p) => {
        const rerankModels = p.models.filter((m) => m.enabled && isRerankModel(m));
        if (rerankModels.length === 0) return null;
        return {
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ModelIcon model={p.name} size={16} type="avatar" />
              {p.name}
            </span>
          ),
          title: p.name,
          options: rerankModels.map((m) => ({
            label: m.name,
            value: `${p.id}::${m.model_id}`,
            modelId: m.model_id,
            providerName: p.name,
          })),
        };
      })
      .filter((opt): opt is NonNullable<typeof opt> => opt !== null);
  }, [providers]);
}

export function RerankModelSelect({
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
  const rerankOptions = useRerankModelOptions();
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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
      options={rerankOptions}
      style={style}
    />
  );
}
