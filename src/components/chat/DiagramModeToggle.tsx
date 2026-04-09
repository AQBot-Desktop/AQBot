import React from 'react';
import { Segmented, theme } from 'antd';
import { Eye, Code2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  showSource: boolean;
  onSwitchMode: (mode: 'preview' | 'source') => void;
}

export const DiagramModeToggle: React.FC<Props> = ({ showSource, onSwitchMode }) => {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  return (
    <Segmented
      size="small"
      value={showSource ? 'source' : 'preview'}
      onChange={(value) => onSwitchMode(value as 'preview' | 'source')}
      options={[
        {
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Eye size={12} />
              {t('common.preview')}
            </span>
          ),
          value: 'preview',
        },
        {
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Code2 size={12} />
              {t('common.source')}
            </span>
          ),
          value: 'source',
        },
      ]}
      style={{ fontSize: token.fontSizeSM }}
    />
  );
};
