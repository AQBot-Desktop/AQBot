import React, { useMemo, useState } from 'react';
import { Button, Tooltip, Typography, theme } from 'antd';
import { Maximize2, Minimize2, Square } from 'lucide-react';
import { ModelIcon } from '@lobehub/icons';
import { useTranslation } from 'react-i18next';
import type { LaneColumn } from '@/lib/multiModelLanes';

export interface MultiModelLaneWorkspaceProps {
  columns: LaneColumn[];
  getModelDisplayInfo: (
    modelId?: string | null,
    providerId?: string | null,
  ) => { modelName: string; providerName: string };
  renderConversation: (column: LaneColumn) => React.ReactNode;
  streamingColumnKeys?: ReadonlySet<string>;
  onStopColumn?: (column: LaneColumn) => void;
}

export const MultiModelLaneWorkspace = React.memo(function MultiModelLaneWorkspace({
  columns,
  getModelDisplayInfo,
  renderConversation,
  streamingColumnKeys,
  onStopColumn,
}: MultiModelLaneWorkspaceProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [maximizedKey, setMaximizedKey] = useState<string | null>(null);
  const headerIds = useMemo(
    () => columns.map((_, index) => `multi-model-lane-${index}`),
    [columns],
  );
  const visibleColumns = maximizedKey
    ? columns.filter((column) => column.key === maximizedKey)
    : columns;

  return (
    <div
      role="region"
      aria-label={t('chat.multiModel.laneWorkspaceLabel')}
      data-testid="multi-model-lane-workspace"
      style={{
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          height: '100%',
          minWidth: '100%',
          overflowX: 'auto',
        }}
      >
        {visibleColumns.map((column, index) => {
          const { modelName, providerName } = getModelDisplayInfo(column.modelId, column.providerId);
          const headerId = headerIds[index] ?? `multi-model-lane-${column.key}`;
          const columnStreaming = streamingColumnKeys?.has(column.key) ?? false;
          return (
            <section
              key={column.key}
              aria-labelledby={headerId}
              data-testid={`multi-model-lane-column-${column.key}`}
              style={{
                minWidth: 280,
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
                borderRight: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              <div
                id={headerId}
                style={{
                  flexShrink: 0,
                  padding: '10px 12px',
                  background: token.colorBgLayout,
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <ModelIcon model={column.modelId} size={20} type="avatar" />
                <span
                  style={{
                    minWidth: 0,
                    flex: 1,
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 6,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {modelName}
                  </span>
                  {providerName ? (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 11, fontWeight: 400, flexShrink: 0 }}
                    >
                      {providerName}
                    </Typography.Text>
                  ) : null}
                </span>
                {column.historical ? (
                  <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
                    {t('chat.multiModel.historicalLane')}
                  </Typography.Text>
                ) : null}
                <Tooltip title={maximizedKey ? t('chat.multiModel.collapseColumn') : t('chat.multiModel.expandColumn')}>
                  <Button
                    type="text"
                    size="small"
                    aria-label={maximizedKey ? t('chat.multiModel.collapseColumn') : t('chat.multiModel.expandColumn')}
                    icon={maximizedKey ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    onClick={() => setMaximizedKey((current) => (current === column.key ? null : column.key))}
                  />
                </Tooltip>
                {columnStreaming && onStopColumn && (
                  <Tooltip title={t('chat.multiModel.stopColumn')}>
                    <Button
                      type="text"
                      size="small"
                      danger
                      aria-label={t('chat.multiModel.stopColumn')}
                      icon={<Square size={12} fill="currentColor" />}
                      onClick={() => onStopColumn(column)}
                    />
                  </Tooltip>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {renderConversation(column)}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
});
