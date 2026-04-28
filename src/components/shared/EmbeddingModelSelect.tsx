import { useMemo, useCallback, useEffect } from 'react';
import { Select, theme } from 'antd';
import { ModelIcon } from '@lobehub/icons';
import { useProviderStore } from '@/stores';
import { parseModelValue, useProviderNameMap } from './ModelSelect';

function isEmbeddingModel(model: { model_id: string; model_type?: string }) {
  return model.model_type === 'Embedding' || /embed/i.test(model.model_id);
}

/** Hook: returns grouped Select options filtered to embedding-capable models */
function useEmbeddingModelOptions() {
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
        const embeddingModels = p.models.filter(
          (m) => m.enabled && isEmbeddingModel(m),
        );
        if (embeddingModels.length === 0) return null;
        return {
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ModelIcon model={p.name} size={16} type="avatar" />
              {p.name}
            </span>
          ),
          title: p.name,
          options: embeddingModels.map((m) => ({
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

/**
 * Model selector filtered to embedding-capable models.
 */
export function EmbeddingModelSelect({
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
  const embeddingOptions = useEmbeddingModelOptions();
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
      options={embeddingOptions}
      style={style}
    />
  );
}
