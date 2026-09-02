import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip, Typography, theme } from 'antd';
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Square } from 'lucide-react';
import { ModelIcon } from '@lobehub/icons';
import { OverlayScrollbars } from 'overlayscrollbars';
import { useTranslation } from 'react-i18next';
import type { LaneColumn } from '@/lib/multiModelLanes';
import {
  MULTI_MODEL_COLUMN_MIN_WIDTH_PX,
  normalizeMultiModelSideBySideWidthMode,
  sideBySideColumnLayout,
  sideBySideTrackStyle,
} from '@/lib/multiModelColumnLayout';
import { useSettingsStore } from '@/stores';

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
  const widthMode = normalizeMultiModelSideBySideWidthMode(
    useSettingsStore((state) => state.settings.multi_model_popout_side_by_side_width_mode),
  );
  const [maximizedKey, setMaximizedKey] = useState<string | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const headerIds = useMemo(
    () => columns.map((_, index) => `multi-model-lane-${index}`),
    [columns],
  );
  const visibleColumns = maximizedKey
    ? columns.filter((column) => column.key === maximizedKey)
    : columns;
  const enableScroll = widthMode === 'scroll' && visibleColumns.length > 1;

  const syncPager = useCallback((viewport: HTMLElement | null) => {
    if (!viewport) {
      setHasOverflow(false);
      setCanPrev(false);
      setCanNext(false);
      return;
    }
    const maxScroll = viewport.scrollWidth - viewport.clientWidth;
    setHasOverflow(maxScroll > 1);
    setCanPrev(viewport.scrollLeft > 1);
    setCanNext(viewport.scrollLeft < maxScroll - 1);
  }, []);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return undefined;

    if (!enableScroll) {
      viewportRef.current = host;
      syncPager(null);
      return undefined;
    }

    const inst = OverlayScrollbars(host, {
      scrollbars: {
        theme: 'os-theme-aqbot',
        autoHide: 'never',
        clickScroll: true,
      },
      overflow: { x: 'scroll', y: 'hidden' },
    });
    const viewport = inst.elements?.().viewport ?? host;
    viewportRef.current = viewport;
    const onScroll = () => syncPager(viewport);
    viewport.addEventListener('scroll', onScroll);
    const observer = new ResizeObserver(onScroll);
    observer.observe(viewport);
    onScroll();

    return () => {
      viewport.removeEventListener('scroll', onScroll);
      observer.disconnect();
      inst.destroy();
    };
  }, [enableScroll, syncPager, visibleColumns.length]);

  const scrollByColumn = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const column = viewport.querySelector<HTMLElement>('[data-testid^="multi-model-lane-column-"]');
    const amount = column?.getBoundingClientRect().width || MULTI_MODEL_COLUMN_MIN_WIDTH_PX;
    viewport.scrollBy({ left: direction * amount, behavior: 'smooth' });
  };

  return (
    <div
      role="region"
      aria-label={t('chat.multiModel.laneWorkspaceLabel')}
      data-testid="multi-model-lane-workspace"
      style={{
        height: '100%',
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        ref={scrollRef}
        className="aqbot-multi-model-lane-scroll"
        style={{
          height: '100%',
          width: '100%',
          minWidth: 0,
          overflowX: enableScroll ? 'auto' : 'hidden',
          overflowY: 'hidden',
        }}
      >
        <div
          className="aqbot-multi-model-lane-track"
          style={{
            ...sideBySideTrackStyle(widthMode, 0),
            height: '100%',
          }}
        >
        {visibleColumns.map((column, index) => {
          const { modelName, providerName } = getModelDisplayInfo(column.modelId, column.providerId);
          const headerId = headerIds[index] ?? `multi-model-lane-${column.key}`;
          const columnStreaming = streamingColumnKeys?.has(column.key) ?? false;
          const columnLayout = sideBySideColumnLayout(visibleColumns.length, widthMode);
          return (
            <section
              key={column.key}
              aria-labelledby={headerId}
              data-testid={`multi-model-lane-column-${column.key}`}
              className={columnLayout.className}
              style={{
                ...columnLayout.style,
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
                borderRight: index < visibleColumns.length - 1
                  ? `1px solid ${token.colorBorderSecondary}`
                  : undefined,
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
      {enableScroll && hasOverflow ? (
        <>
          <Button
            type="default"
            size="small"
            data-testid="multi-model-lane-prev"
            aria-label={t('chat.multiModel.prevColumns')}
            disabled={!canPrev}
            icon={<ChevronLeft size={16} />}
            onClick={() => scrollByColumn(-1)}
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 2,
              background: token.colorBgElevated,
            }}
          />
          <Button
            type="default"
            size="small"
            data-testid="multi-model-lane-next"
            aria-label={t('chat.multiModel.nextColumns')}
            disabled={!canNext}
            icon={<ChevronRight size={16} />}
            onClick={() => scrollByColumn(1)}
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 2,
              background: token.colorBgElevated,
            }}
          />
        </>
      ) : null}
    </div>
  );
});
