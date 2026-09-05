import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Select } from 'antd';
import { useTranslation } from 'react-i18next';
import {
  MODEL_SELECT_CLASS,
  ModelSelectValueLabel,
  parseModelValue,
  useGroupedModelOptions,
  useModelSelectOptionRender,
  useProviderNameMap,
} from '@/components/shared/ModelSelect';
import { useProviderStore } from '@/stores/providerStore';
import { useSelectionToolbarStore } from '@/stores/selectionToolbarStore';
import type { SelectionToolbarModelTarget } from '@/types';

const DROPDOWN_MAX_HEIGHT = 190;
const POPUP_EDGE_GAP = 8;
export const SELECTION_TOOLBAR_MODEL_DROPDOWN_CLASS = 'selection-toolbar__model-dropdown';

const MODEL_POPUP_OVERFLOW = {
  adjustX: true,
  adjustY: true,
  shiftX: true,
  shiftY: true,
} as const;

const MODEL_POPUP_PLACEMENTS = {
  bottomLeft: { points: ['tl', 'bl'], offset: [0, 4], overflow: MODEL_POPUP_OVERFLOW, htmlRegion: 'visible' as const, dynamicInset: true },
  bottomRight: { points: ['tr', 'br'], offset: [0, 4], overflow: MODEL_POPUP_OVERFLOW, htmlRegion: 'visible' as const, dynamicInset: true },
  topLeft: { points: ['bl', 'tl'], offset: [0, -4], overflow: MODEL_POPUP_OVERFLOW, htmlRegion: 'visible' as const, dynamicInset: true },
  topRight: { points: ['br', 'tr'], offset: [0, -4], overflow: MODEL_POPUP_OVERFLOW, htmlRegion: 'visible' as const, dynamicInset: true },
};

function modelValue(target: SelectionToolbarModelTarget | null | undefined): string | undefined {
  if (!target) return undefined;
  return `${target.provider_id}::${target.model_id}`;
}

function matchesModelQuery(
  query: string,
  option?: { label?: unknown; value?: unknown; modelId?: string; providerName?: string; options?: unknown },
): boolean {
  if (!query) return true;
  if (!option || option.options) return false;
  const haystack = [option.label, option.value, option.modelId, option.providerName]
    .map((value) => String(value ?? '').toLowerCase())
    .join('\n');
  return haystack.includes(query);
}

export function SelectionToolbarModelSelect() {
  const { t } = useTranslation();
  const session = useSelectionToolbarStore((state) => state.session);
  const pending = useSelectionToolbarStore((state) => state.pendingRequest);
  const run = useSelectionToolbarStore((state) => state.run);
  const busy = useSelectionToolbarStore((state) => state.busy);
  const selectedModelTarget = useSelectionToolbarStore((state) => state.selectedModelTarget);
  const selectModelTarget = useSelectionToolbarStore((state) => state.selectModelTarget);
  const providers = useProviderStore((state) => state.providers);
  const loading = useProviderStore((state) => state.loading);
  const loadError = useProviderStore((state) => state.error);
  const ensureProvidersLoaded = useProviderStore((state) => state.ensureProvidersLoaded);
  const screenshot = session?.input_kind === 'screenshot' || pending?.input?.kind === 'screenshot';
  const groupedOptions = useGroupedModelOptions('Chat', screenshot ? 'Vision' : undefined);
  const providerNameMap = useProviderNameMap();
  const optionRender = useModelSelectOptionRender();
  const [open, setOpen] = useState(false);
  const streaming = run?.status === 'started' || run?.status === 'streaming';
  const displayed = selectedModelTarget ?? run?.model_target ?? null;
  const value = modelValue(displayed);
  const availableValues = useMemo(
    () => new Set(groupedOptions.flatMap((group) => group.options.map((option) => option.value))),
    [groupedOptions],
  );
  const unavailable = Boolean(value && !loading && !availableValues.has(value));

  useEffect(() => {
    void ensureProvidersLoaded().catch(() => {});
  }, [ensureProvidersLoaded]);

  const filterOption = useCallback((input: string, option?: Parameters<typeof matchesModelQuery>[1]) => (
    matchesModelQuery(input.trim().toLowerCase(), option)
  ), []);

  const labelRender = useCallback((props: { label?: ReactNode; value?: string | number }) => {
    const parsed = parseModelValue(String(props.value ?? ''));
    if (!parsed) return <span>{props.label}</span>;
    const providerName = providerNameMap.get(parsed.providerId) ?? '';
    const model = providers
      .find((provider) => provider.id === parsed.providerId)
      ?.models.find((item) => item.model_id === parsed.modelId);
    const label = model?.name ?? parsed.modelId;
    const title = providerName ? `${label} (${providerName})` : label;
    return (
      <span title={title}>
        <ModelSelectValueLabel modelId={parsed.modelId} label={label} />
      </span>
    );
  }, [providerNameMap, providers]);

  const notFoundContent = useMemo(() => {
    if (loading) return t('common.loading');
    if (loadError) return t('settings.selectionToolbar.modelLoadFailed');
    return t(screenshot
      ? 'settings.selectionToolbar.modelVisionEmpty'
      : 'settings.selectionToolbar.modelEmpty');
  }, [loadError, loading, screenshot, t]);

  const popupMaxWidth = `calc(100vw - ${POPUP_EDGE_GAP * 2}px)`;

  return (
    <Select
      allowClear={false}
      aria-label={t('settings.selectionToolbar.modelSelect')}
      builtinPlacements={MODEL_POPUP_PLACEMENTS}
      className={`${MODEL_SELECT_CLASS} selection-toolbar__model-select`}
      classNames={{ popup: { root: SELECTION_TOOLBAR_MODEL_DROPDOWN_CLASS } }}
      disabled={busy || streaming}
      filterOption={filterOption}
      getPopupContainer={() => document.body}
      labelRender={labelRender}
      listHeight={DROPDOWN_MAX_HEIGHT}
      loading={loading}
      notFoundContent={notFoundContent}
      optionRender={optionRender}
      options={groupedOptions}
      placeholder={t(open && !value
        ? 'settings.selectionToolbar.modelSearchPlaceholder'
        : 'settings.selectionToolbar.modelPlaceholder')}
      placement="bottomRight"
      popupMatchSelectWidth={false}
      showSearch
      size="small"
      styles={{ popup: { root: { maxHeight: DROPDOWN_MAX_HEIGHT, maxWidth: popupMaxWidth } } }}
      title={unavailable
        ? t('settings.selectionToolbar.modelUnavailable')
        : t('settings.selectionToolbar.modelSelect')}
      value={value}
      variant="borderless"
      onChange={(next) => {
        const parsed = parseModelValue(next);
        if (!parsed) return;
        selectModelTarget({ provider_id: parsed.providerId, model_id: parsed.modelId });
      }}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void ensureProvidersLoaded({ force: true }).catch(() => {});
      }}
    />
  );
}

export function SelectionToolbarTurnModel({
  target,
}: {
  target: SelectionToolbarModelTarget | null | undefined;
}) {
  const providers = useProviderStore((state) => state.providers);
  if (!target) return null;
  const provider = providers.find((item) => item.id === target.provider_id);
  const name = provider?.models.find((item) => item.model_id === target.model_id)?.name
    ?? target.model_id;
  const title = provider?.name ? `${name} (${provider.name})` : name;
  return (
    <div className="selection-toolbar__turn-model" title={title}>{name}</div>
  );
}
