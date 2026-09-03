import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  MULTI_MODEL_COLUMN_RESIZE_GUTTER_PX,
  clampCustomColumnWidthPx,
} from '@/lib/multiModelColumnLayout';

export function MultiModelColumnResizeHandle({
  ariaLabel,
  columnEl,
  maxWidthPx,
  onPreview,
  onCommit,
  onCancel,
}: {
  ariaLabel: string;
  columnEl: HTMLElement | null;
  maxWidthPx: number;
  onPreview: (widthPx: number) => void;
  onCommit: (widthPx: number) => void;
  onCancel: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!columnEl) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      startX: event.clientX,
      startWidth: columnEl.getBoundingClientRect().width,
    };
    setDragging(true);
  }, [columnEl]);

  useEffect(() => {
    if (!dragging) return undefined;

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const nextWidth = clampCustomColumnWidthPx(
        Math.min(maxWidthPx, drag.startWidth + event.clientX - drag.startX),
      );
      onPreview(nextWidth);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (!drag) return;
      onCommit(clampCustomColumnWidthPx(
        Math.min(maxWidthPx, drag.startWidth + event.clientX - drag.startX),
      ));
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dragRef.current = null;
        setDragging(false);
        onCancel();
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [dragging, maxWidthPx, onCancel, onCommit, onPreview]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      data-testid="multi-model-column-resize-handle"
      onPointerDown={handlePointerDown}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: MULTI_MODEL_COLUMN_RESIZE_GUTTER_PX,
        height: '100%',
        cursor: 'col-resize',
        zIndex: 4,
        touchAction: 'none',
        background: dragging ? 'rgba(23, 169, 61, 0.18)' : 'transparent',
      }}
    />
  );
}
