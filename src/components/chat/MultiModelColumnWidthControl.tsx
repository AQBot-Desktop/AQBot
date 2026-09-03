import { Button, InputNumber, Popover, Tooltip } from 'antd';
import { Columns2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MULTI_MODEL_COLUMN_CUSTOM_MIN_WIDTH_PX } from '@/lib/multiModelColumnLayout';

export function MultiModelColumnWidthControl({
  currentWidthPx,
  onCommit,
  onReset,
}: {
  currentWidthPx: number;
  onCommit: (widthPx: number) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentWidthPx);

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && value !== currentWidthPx) onCommit(value);
        setOpen(nextOpen);
        if (nextOpen) setValue(currentWidthPx);
      }}
      content={(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 180 }}>
          <InputNumber
            aria-label={t('chat.multiModel.columnWidthPx')}
            min={MULTI_MODEL_COLUMN_CUSTOM_MIN_WIDTH_PX}
            value={value}
            onChange={(next) => {
              if (typeof next === 'number') setValue(next);
            }}
            onPressEnter={() => {
              onCommit(value);
              setOpen(false);
            }}
            addonAfter="px"
            style={{ width: '100%' }}
          />
          <Button
            size="small"
            onClick={() => {
              onReset();
              setOpen(false);
            }}
          >
            {t('chat.multiModel.resetColumnWidth')}
          </Button>
        </div>
      )}
    >
      <Tooltip title={t('chat.multiModel.columnWidth')}>
        <Button
          type="text"
          size="small"
          aria-label={t('chat.multiModel.columnWidth')}
          icon={<Columns2 size={14} />}
        />
      </Tooltip>
    </Popover>
  );
}
