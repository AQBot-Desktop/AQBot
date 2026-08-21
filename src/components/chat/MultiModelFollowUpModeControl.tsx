import { Segmented, Tooltip, theme } from 'antd';
import { GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  normalizeMultiModelContinuationMode,
  type MultiModelContinuationMode,
} from '@/lib/multiModelContinuation';

interface MultiModelFollowUpModeControlProps {
  value: MultiModelContinuationMode;
  onChange: (mode: MultiModelContinuationMode) => void;
}

export function MultiModelFollowUpModeControl({
  value,
  onChange,
}: MultiModelFollowUpModeControlProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  return (
    <div
      data-testid="multi-model-follow-up-mode"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs"
      aria-label={t('chat.multiModel.followUpMode')}
      style={{
        color: token.colorTextSecondary,
        borderRadius: token.borderRadiusSM,
        backgroundColor: token.colorFillTertiary,
      }}
    >
      <GitBranch size={12} aria-hidden="true" />
      <span>{t('chat.multiModel.followUpMode')}</span>
      <Segmented
        size="small"
        value={value}
        onChange={(nextValue) => onChange(normalizeMultiModelContinuationMode(nextValue))}
        options={[
          {
            value: 'selected',
            label: (
              <Tooltip title={t('chat.multiModel.followUpModeSelectedDesc')}>
                <span>{t('chat.multiModel.followUpModeSelected')}</span>
              </Tooltip>
            ),
          },
          {
            value: 'per_model',
            label: (
              <Tooltip title={t('chat.multiModel.followUpModePerModelDesc')}>
                <span>{t('chat.multiModel.followUpModePerModel')}</span>
              </Tooltip>
            ),
          },
        ]}
      />
    </div>
  );
}
