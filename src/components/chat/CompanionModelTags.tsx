import { Button, Dropdown, theme, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { ModelIcon } from '@lobehub/icons';
import { Atom, Trash2, X } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getModelVersionGroupKey } from '@/lib/chatMultiModel';
import { findModelByIds, supportsReasoning } from '@/lib/modelCapabilities';
import {
  normalizeMultiModelContinuationMode,
  type MultiModelContinuationMode,
} from '@/lib/multiModelContinuation';
import {
  normalizeMultiModelExecutionMode,
  normalizeMultiModelSequentialInterval,
} from '@/lib/multiModelExecution';
import {
  coerceReasoningOptionKey,
  legacyThinkingBudgetToOptionKey,
  resolveReasoningProfile,
} from '@/lib/reasoningProfile';
import {
  FOLLOW_UNIFIED_THINKING_KEY,
  resolveTargetReasoning,
  withTargetThinkingOverride,
} from '@/lib/resolveTargetReasoning';
import type {
  MultiModelRunSnapshot,
  MultiModelTarget,
  ProviderConfig,
} from '@/types';
import { MultiModelFollowUpModeControl } from './MultiModelFollowUpModeControl';
import { thinkingOptionIcon } from './thinkingOptionIcon';

interface CompanionModelTagsProps {
  targets: MultiModelTarget[];
  providers: ProviderConfig[];
  unifiedThinkingLevel: string | null;
  unifiedThinkingBudget: number | null;
  executionMode?: string | null;
  sequentialIntervalSeconds?: number | null;
  historyMode: MultiModelContinuationMode;
  multiModelRun?: MultiModelRunSnapshot | null;
  onTargetsChange: (targets: MultiModelTarget[]) => void;
  onHistoryModeChange: (mode: MultiModelContinuationMode) => void;
  onClearAll: () => void;
}

export function CompanionModelTags({
  targets,
  providers,
  unifiedThinkingLevel,
  unifiedThinkingBudget,
  executionMode,
  sequentialIntervalSeconds,
  historyMode,
  multiModelRun,
  onTargetsChange,
  onHistoryModeChange,
  onClearAll,
}: CompanionModelTagsProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const sequential = normalizeMultiModelExecutionMode(executionMode) === 'sequential';
  const displayInfos = useMemo(() => targets.map((target) => {
    const provider = providers.find((item) => item.id === target.providerId);
    const model = findModelByIds(providers, target.providerId, target.modelId);
    const unavailable = !provider?.enabled || !model?.enabled;
    return {
      target,
      provider,
      model,
      modelName: model?.name ?? target.modelId,
      providerName: provider?.name ?? '',
      unavailable,
    };
  }), [providers, targets]);
  const hasUnavailable = displayInfos.some((item) => item.unavailable);

  const moveTarget = (index: number, offset: number) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= targets.length) return;
    const next = [...targets];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onTargetsChange(next);
  };

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-3 pb-1">
      <span
        className="inline-flex items-center px-2 py-0.5 text-xs"
        style={{ color: token.colorTextTertiary }}
      >
        {t('chat.multiModel.selectTitle')}:
      </span>
      <span
        className="inline-flex items-center px-2 py-0.5 text-xs"
        style={{
          color: token.colorTextSecondary,
          backgroundColor: token.colorFillSecondary,
          borderRadius: token.borderRadiusSM,
        }}
      >
        {sequential
          ? t('chat.multiModel.executionBadgeSequential')
          : t('chat.multiModel.executionBadgeParallel')}
        {sequential && (
          <> · {t('chat.multiModel.intervalBadge', {
            seconds: normalizeMultiModelSequentialInterval(sequentialIntervalSeconds),
          })}</>
        )}
      </span>
      {displayInfos.map((item, idx) => {
        const canThink = !item.unavailable && supportsReasoning(item.model);
        const profile = resolveReasoningProfile(item.provider?.provider_type, item.model);
        const resolved = resolveTargetReasoning({
          unifiedLevel: unifiedThinkingLevel,
          unifiedBudget: unifiedThinkingBudget,
          override: item.target.thinkingLevel,
          providerType: item.provider?.provider_type,
          model: item.model,
        });
        const effectiveKey = resolved.thinkingLevel
          ?? coerceReasoningOptionKey(
            profile,
            resolved.thinkingBudget == null
              ? null
              : legacyThinkingBudgetToOptionKey(profile, resolved.thinkingBudget),
          );
        const effectiveOption = profile.options.find((option) => option.key === effectiveKey)
          ?? profile.options[0];
        const followingUnified = item.target.thinkingLevel === undefined;
        const selectedKey = followingUnified
          ? FOLLOW_UNIFIED_THINKING_KEY
          : (item.target.thinkingLevel ?? 'default');
        const thinkingItems: MenuProps['items'] = [
          {
            key: FOLLOW_UNIFIED_THINKING_KEY,
            label: t('chat.thinking.followUnified'),
            icon: <Atom size={12} />,
          },
          { type: 'divider' },
          ...profile.options.map((option) => ({
            key: option.key,
            label: t(option.labelKey),
            icon: thinkingOptionIcon(option.icon, 12),
          })),
        ];

        return (
          <span
            key={getModelVersionGroupKey(item.target.providerId, item.target.modelId)}
            className="inline-flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 text-xs"
            title={item.unavailable ? t('chat.multiModel.unavailableModel') : undefined}
            style={{
              backgroundColor: item.unavailable ? token.colorWarningBg : token.colorFillSecondary,
              borderRadius: token.borderRadiusSM,
              color: token.colorText,
            }}
          >
            <span style={{
              minWidth: 16,
              textAlign: 'center',
              color: token.colorPrimary,
              fontWeight: 600,
            }}>{idx + 1}</span>
            <button
              type="button"
              aria-label={t('chat.multiModel.moveUp')}
              disabled={idx === 0}
              onClick={() => moveTarget(idx, -1)}
              style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                cursor: idx === 0 ? 'default' : 'pointer',
                color: token.colorTextTertiary,
              }}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={t('chat.multiModel.moveDown')}
              disabled={idx === targets.length - 1}
              onClick={() => moveTarget(idx, 1)}
              style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                cursor: idx === targets.length - 1 ? 'default' : 'pointer',
                color: token.colorTextTertiary,
              }}
            >
              ↓
            </button>
            <ModelIcon model={item.target.modelId} size={14} type="avatar" />
            <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.modelName}
            </span>
            {item.providerName && (
              <span style={{ color: token.colorTextQuaternary, fontSize: 11 }}>
                {item.providerName}
              </span>
            )}
            {canThink && (
              <Dropdown
                trigger={['click']}
                placement="topLeft"
                menu={{
                  items: thinkingItems,
                  selectable: true,
                  selectedKeys: [selectedKey],
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation();
                    const next = [...targets];
                    next[idx] = withTargetThinkingOverride(item.target, key);
                    onTargetsChange(next);
                  },
                }}
              >
                <Tooltip
                  title={`${t('chat.multiModel.thinkingOverride', { model: item.modelName })}: ${
                    followingUnified
                      ? t('chat.thinking.followUnified')
                      : t(effectiveOption.labelKey)
                  }`}
                >
                  <Button
                    type="text"
                    size="small"
                    data-testid={`companion-thinking-${idx}`}
                    aria-label={t('chat.multiModel.thinkingOverride', { model: item.modelName })}
                    icon={thinkingOptionIcon(effectiveOption.icon, 12)}
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      width: 22,
                      height: 22,
                      padding: 0,
                      color: followingUnified
                        ? token.colorTextTertiary
                        : effectiveOption.key === 'off' || effectiveOption.key === 'none'
                          ? token.colorError
                          : token.colorPrimary,
                    }}
                  />
                </Tooltip>
              </Dropdown>
            )}
            <X
              size={12}
              className="cursor-pointer flex-shrink-0"
              style={{ color: token.colorTextTertiary }}
              onClick={() => onTargetsChange(targets.filter((_, index) => index !== idx))}
            />
          </span>
        );
      })}
      {hasUnavailable && (
        <span style={{ color: token.colorWarning, fontSize: 12 }}>
          {t('chat.multiModel.unavailableModel')}
        </span>
      )}
      {multiModelRun?.phase === 'waiting' && multiModelRun.nextStartAt != null && (
        <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
          {t('chat.multiModel.waitingNext', {
            seconds: Math.max(0, Math.ceil((multiModelRun.nextStartAt - Date.now()) / 1000)),
          })}
        </span>
      )}
      {targets.length >= 2 && (
        <MultiModelFollowUpModeControl
          value={normalizeMultiModelContinuationMode(historyMode)}
          onChange={onHistoryModeChange}
        />
      )}
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs cursor-pointer"
        style={{
          borderRadius: token.borderRadiusSM,
          color: token.colorTextTertiary,
        }}
        onClick={onClearAll}
      >
        <Trash2 size={11} />
        {t('chat.clearAll')}
      </span>
    </div>
  );
}
