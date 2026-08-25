import React, { useMemo, useState } from 'react';
import { Button, Tooltip, Typography, theme } from 'antd';
import { Maximize2, Minimize2, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Message } from '@/types';
import { selectLaneAnswer, type LaneColumn } from '@/lib/multiModelLanes';

export interface MultiModelLaneWorkspaceProps {
  userMessages: Message[];
  versionsByParentId: Record<string, Message[]>;
  columns: LaneColumn[];
  activeMessageIdByParent?: Record<string, string | undefined>;
  displayVersionIdsByParent?: Map<string, Map<string, string>>;
  getModelDisplayInfo: (
    modelId?: string | null,
    providerId?: string | null,
  ) => { modelName: string; providerName: string };
  renderUser: (message: Message) => React.ReactNode;
  renderAnswer: (message: Message, isStreaming: boolean) => React.ReactNode;
  streamingMessageId?: string | null;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  variant?: 'cards' | 'split';
  onStopColumn?: (column: LaneColumn) => void;
}

export const MultiModelLaneWorkspace = React.memo(function MultiModelLaneWorkspace({
  userMessages,
  versionsByParentId,
  columns,
  activeMessageIdByParent,
  displayVersionIdsByParent,
  getModelDisplayInfo,
  renderUser,
  renderAnswer,
  streamingMessageId,
  onScroll,
  variant = 'cards',
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
  const isSplit = variant === 'split';

  return (
    <div
      role="region"
      aria-label={t('chat.multiModel.laneWorkspaceLabel')}
      onScroll={isSplit ? undefined : onScroll}
      style={{
        height: '100%',
        overflow: isSplit ? 'hidden' : 'auto',
        padding: isSplit ? 0 : '16px 24px',
      }}
    >
      <div
        style={isSplit
          ? {
              display: 'flex',
              height: '100%',
              minWidth: '100%',
            }
          : {
              display: 'grid',
              gridAutoFlow: 'column',
              gridAutoColumns: 'minmax(320px, 1fr)',
              gap: 12,
              minWidth: '100%',
              alignItems: 'start',
            }}
      >
        {visibleColumns.map((column, index) => {
          const { modelName } = getModelDisplayInfo(column.modelId, column.providerId);
          const headerId = headerIds[index] ?? `multi-model-lane-${column.key}`;
          const columnStreaming = userMessages.some((userMessage) => {
            const answer = selectLaneAnswer(
              versionsByParentId[userMessage.id] ?? [],
              column,
              activeMessageIdByParent?.[userMessage.id],
              displayVersionIdsByParent?.get(userMessage.id),
            );
            return Boolean(answer && streamingMessageId === answer.id);
          });
          return (
            <section
              key={column.key}
              aria-labelledby={headerId}
              style={{
                minWidth: isSplit ? 280 : 320,
                flex: isSplit ? 1 : undefined,
                display: 'flex',
                flexDirection: 'column',
                gap: isSplit ? 0 : 12,
                height: isSplit ? '100%' : undefined,
                borderRight: isSplit ? `1px solid ${token.colorBorderSecondary}` : undefined,
                background: isSplit ? token.colorFillAlter : undefined,
              }}
            >
              <div
                id={headerId}
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  padding: isSplit ? '10px 12px' : '8px 12px',
                  background: token.colorBgContainer,
                  border: isSplit ? undefined : `1px solid ${token.colorBorderSecondary}`,
                  borderBottom: isSplit ? `1px solid ${token.colorBorderSecondary}` : undefined,
                  borderRadius: isSplit ? 0 : token.borderRadiusLG,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {modelName}
                </span>
                {column.historical ? (
                  <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
                    {t('chat.multiModel.historicalLane')}
                  </Typography.Text>
                ) : null}
                {isSplit && (
                  <Tooltip title={maximizedKey ? t('chat.multiModel.collapseColumn') : t('chat.multiModel.expandColumn')}>
                    <Button
                      type="text"
                      size="small"
                      aria-label={maximizedKey ? t('chat.multiModel.collapseColumn') : t('chat.multiModel.expandColumn')}
                      icon={maximizedKey ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                      onClick={() => setMaximizedKey((current) => (current === column.key ? null : column.key))}
                    />
                  </Tooltip>
                )}
                {isSplit && columnStreaming && onStopColumn && (
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
              <div
                onScroll={isSplit ? onScroll : undefined}
                style={{
                  flex: isSplit ? 1 : undefined,
                  overflow: isSplit ? 'auto' : undefined,
                  padding: isSplit ? 16 : 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                {userMessages.map((userMessage) => {
                  const versions = versionsByParentId[userMessage.id] ?? [];
                  const answer = selectLaneAnswer(
                    versions,
                    column,
                    activeMessageIdByParent?.[userMessage.id],
                    displayVersionIdsByParent?.get(userMessage.id),
                  );
                  const isStreaming = Boolean(answer && streamingMessageId === answer.id);
                  return (
                    <article
                      key={`${column.key}-${userMessage.id}`}
                      aria-busy={isStreaming}
                      style={{
                        border: isSplit ? undefined : `1px solid ${token.colorBorderSecondary}`,
                        borderRadius: token.borderRadiusLG,
                        padding: isSplit ? 0 : 12,
                        background: isSplit ? 'transparent' : token.colorBgElevated,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div aria-label={t('chat.multiModel.laneQuestionLabel')}>
                        {renderUser(userMessage)}
                      </div>
                      {answer ? (
                        renderAnswer(answer, isStreaming)
                      ) : (
                        <Typography.Text type="secondary">
                          {t('chat.multiModel.lanePlaceholder')}
                        </Typography.Text>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
});
