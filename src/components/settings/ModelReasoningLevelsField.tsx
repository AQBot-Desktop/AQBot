import { Segmented, Tag, Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ReasoningOption, ReasoningOptionKey } from '@/lib/reasoningProfile';

const { Text } = Typography;

export type ReasoningLevelsMode = 'auto' | 'custom';

interface ModelReasoningLevelsFieldProps {
  mode: ReasoningLevelsMode;
  /** Levels the chat selector shows when the mode is automatic. */
  autoOptions: ReasoningOption[];
  /** Every level the current thinking param style can carry. */
  availableOptions: ReasoningOption[];
  selected: ReasoningOptionKey[];
  /** No request style was matched, so there is nothing to pick from yet. */
  styleUnresolved: boolean;
  switching: boolean;
  onModeChange: (mode: ReasoningLevelsMode) => void;
  onSelectedChange: (selected: ReasoningOptionKey[]) => void;
}

export function ModelReasoningLevelsField({
  mode,
  autoOptions,
  availableOptions,
  selected,
  styleUnresolved,
  switching,
  onModeChange,
  onSelectedChange,
}: ModelReasoningLevelsFieldProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const label = (option: ReasoningOption) => t(option.labelKey, option.fallbackLabel);

  const toggle = (key: ReasoningOptionKey, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(key);
    else next.delete(key);
    onSelectedChange(
      availableOptions.map((option) => option.key).filter((optionKey) => next.has(optionKey)),
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm" style={{ color: token.colorText }}>
            {t('settings.reasoningLevels')}
          </div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t(styleUnresolved ? 'settings.reasoningLevelsNeedStyle' : 'settings.reasoningLevelsHint')}
          </Text>
        </div>
        {!styleUnresolved && (
          <Segmented
            size="small"
            value={mode}
            disabled={switching}
            onChange={(value) => onModeChange(value as ReasoningLevelsMode)}
            options={[
              { value: 'auto', label: t('settings.reasoningLevelsAuto') },
              { value: 'custom', label: t('settings.reasoningLevelsCustom') },
            ]}
          />
        )}
      </div>
      {!styleUnresolved && (
        <div className="flex gap-2 flex-wrap mt-2">
          {mode === 'auto'
            ? autoOptions
                .filter((option) => option.key !== 'default')
                .map((option) => <Tag key={option.key}>{label(option)}</Tag>)
            : availableOptions
                .filter((option) => option.key !== 'default')
                .map((option) => {
                  const checked = selected.includes(option.key);
                  return (
                    <Tag.CheckableTag
                      key={option.key}
                      checked={checked}
                      // Keep at least one level so the custom list never collapses back to inference.
                      onChange={(next) => {
                        if (!next && selected.length <= 1) return;
                        toggle(option.key, next);
                      }}
                    >
                      {label(option)}
                    </Tag.CheckableTag>
                  );
                })}
        </div>
      )}
    </div>
  );
}
