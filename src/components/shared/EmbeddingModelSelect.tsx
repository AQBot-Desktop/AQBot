import { useMemo, useEffect, type CSSProperties } from 'react';
import { Select } from 'antd';
import { ModelIcon } from '@lobehub/icons';
import { useTranslation } from 'react-i18next';
import { useProviderStore } from '@/stores';
import { BUILTIN_EMBEDDING_REF, isBuiltinEmbeddingRef } from '@/lib/embeddingProfiles';
import { useEmbeddingArtifact } from '@/lib/useEmbeddingArtifact';
import {
  MODEL_SELECT_CLASS,
  useProviderNameMap,
  useModelSelectLabelRender,
  useModelSelectOptionRender,
} from './ModelSelect';

function isEmbeddingModel(model: { model_id: string; model_type?: string }) {
  return model.model_type === 'Embedding' || /embed/i.test(model.model_id);
}

/** Hook: returns grouped Select options filtered to embedding-capable models */
function useEmbeddingModelOptions() {
  const { t } = useTranslation();
  const providers = useProviderStore((s) => s.providers);
  const ensureProvidersLoaded = useProviderStore((s) => s.ensureProvidersLoaded);

  useEffect(() => {
    void ensureProvidersLoaded();
  }, [ensureProvidersLoaded]);

  return useMemo(() => {
    const builtinGroup = {
      label: t('settings.localRetrieval.builtinGroup'),
      title: t('settings.localRetrieval.builtinGroup'),
      options: [
        {
          label: t('settings.localRetrieval.builtinModelId'),
          value: BUILTIN_EMBEDDING_REF,
          modelId: 'multilingual-e5-small',
          providerName: t('settings.localRetrieval.builtinGroup'),
        },
      ],
    };
    const remoteGroups = providers
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
    return [builtinGroup, ...remoteGroups];
  }, [providers, t]);
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
  className,
}: {
  value?: string;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  allowClear?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const { t } = useTranslation();
  const { currentStatus } = useEmbeddingArtifact();
  const embeddingOptions = useEmbeddingModelOptions();
  const providerNameMap = useProviderNameMap();
  const labelMap = useMemo(() => {
    const map = new Map(providerNameMap);
    map.set('builtin', t('settings.localRetrieval.builtinGroup'));
    return map;
  }, [providerNameMap, t]);
  const optionRender = useModelSelectOptionRender();
  const labelRender = useModelSelectLabelRender(labelMap);

  const width = style?.width ?? '100%';

  return (
    <div className="aqbot-embedding-select" style={{ width, minWidth: 0 }}>
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
        options={embeddingOptions}
        popupMatchSelectWidth
        style={{ width: '100%' }}
      />
      {isBuiltinEmbeddingRef(value) ? (
        <p className="aqbot-embedding-select-hint">
          {t(
            currentStatus === 'installed'
              ? 'settings.localRetrieval.installedShort'
              : currentStatus === 'downloading'
                ? 'settings.localRetrieval.status.downloading'
                : 'settings.localRetrieval.notInstalledShort',
          )}
        </p>
      ) : null}
    </div>
  );
}
