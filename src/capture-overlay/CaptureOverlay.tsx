import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import i18n from '@/i18n';
import { invoke } from '@/lib/invoke';
import { pixelRegion, type Point } from './geometry';
import './captureOverlay.css';

type CaptureSnapshot = { capture_id: string; width: number; height: number; language: string };
type Drag = { pointerId: number; start: Point; end: Point };

const ERROR_KEYS: Record<string, string> = {
  capture_failed: 'settings.selectionToolbar.captureFailed',
  capture_permission_required: 'settings.selectionToolbar.capturePermissionRequired',
  capture_unavailable: 'settings.selectionToolbar.captureUnavailable',
  capture_busy: 'settings.selectionToolbar.captureBusy',
  capture_invalid_region: 'settings.selectionToolbar.captureInvalidRegion',
  capture_expired: 'settings.selectionToolbar.captureExpired',
  capture_too_large: 'settings.selectionToolbar.captureTooLarge',
};

export function CaptureOverlay() {
  const { t } = useTranslation();
  const [source, setSource] = useState<string>();
  const [imageReady, setImageReady] = useState(false);
  const [drag, setDrag] = useState<Drag>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const snapshot = useRef<CaptureSnapshot | undefined>(undefined);
  const dragRef = useRef<Drag | undefined>(undefined);
  const busyRef = useRef(false);
  const alive = useRef(true);

  function reportError(reason: unknown) {
    if (alive.current) setError(reason);
  }

  async function cancel() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (snapshot.current) {
        await invoke('capture_overlay_cancel', { captureId: snapshot.current.capture_id });
      } else {
        await getCurrentWebviewWindow().close();
      }
    } catch (reason) {
      reportError(reason);
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  useEffect(() => {
    let objectUrl: string | undefined;
    alive.current = true;
    document.documentElement.classList.add('capture-overlay-active');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void cancel();
      }
    };
    const onResize = () => {
      dragRef.current = undefined;
      setDrag(undefined);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    void (async () => {
      const current = await invoke<CaptureSnapshot>('capture_overlay_snapshot');
      snapshot.current = current;
      await i18n.changeLanguage(current.language);
      document.documentElement.lang = current.language;
      document.documentElement.dir = i18n.dir(current.language);
      const bytes = await invoke<ArrayBuffer>('capture_overlay_image', { captureId: current.capture_id });
      if (!alive.current) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      setSource(objectUrl);
    })().catch(reportError);
    return () => {
      alive.current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      document.documentElement.classList.remove('capture-overlay-active');
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  function pointFor(event: PointerEvent<HTMLDivElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(bounds.width, Math.max(0, event.clientX - bounds.left)),
      y: Math.min(bounds.height, Math.max(0, event.clientY - bounds.top)),
    };
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !imageReady || busyRef.current || !snapshot.current
      || (event.target as HTMLElement).closest('[data-capture-control]')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFor(event);
    dragRef.current = { pointerId: event.pointerId, start: point, end: point };
    setError(undefined);
    setDrag(dragRef.current);
  }

  async function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = snapshot.current;
    const selection = dragRef.current;
    if (!current || !selection || selection.pointerId !== event.pointerId || busyRef.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const region = pixelRegion(selection.start, pointFor(event), { viewport: bounds, image: current });
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = undefined;
    if (!region) {
      setDrag(undefined);
      reportError({ code: 'capture_invalid_region' });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await invoke('capture_overlay_confirm', { captureId: current.capture_id, region });
    } catch (reason) {
      reportError(reason);
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const details = error && typeof error === 'object' ? error as { code?: string; detail?: string } : undefined;
  const errorMessage = error ? t(ERROR_KEYS[details?.code ?? ''] ?? ERROR_KEYS.capture_failed,
    { error: details?.detail ?? String(error) }) : undefined;
  return (
    <div
      className="capture-overlay"
      aria-label={t('settings.selectionToolbar.captureInstructions')}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={pointerDown}
      onPointerMove={(event) => {
        if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
        dragRef.current = { ...dragRef.current, end: pointFor(event) };
        setDrag(dragRef.current);
      }}
      onPointerUp={(event) => void pointerUp(event)}
      onPointerCancel={() => { dragRef.current = undefined; setDrag(undefined); }}
    >
      {source && <img className="capture-overlay__image" src={source} draggable={false}
        alt={t('settings.selectionToolbar.screenshotPreview')}
        onLoad={() => setImageReady(true)}
        onError={() => {
          setImageReady(false);
          dragRef.current = undefined;
          setDrag(undefined);
          reportError(t('settings.selectionToolbar.capturePreviewFailed'));
        }} />}
      {drag ? <div className="capture-overlay__selection" style={{
        left: Math.min(drag.start.x, drag.end.x), top: Math.min(drag.start.y, drag.end.y),
        width: Math.abs(drag.end.x - drag.start.x), height: Math.abs(drag.end.y - drag.start.y),
      }} /> : <div className="capture-overlay__shade" />}
      <div className="capture-overlay__instructions" data-capture-control>
        <span>{t('settings.selectionToolbar.captureInstructions')}</span>
        <button type="button" disabled={busy} onClick={() => void cancel()}>{t('common.cancel')}</button>
      </div>
      {errorMessage && <div className="capture-overlay__error" role="alert" data-capture-control>{errorMessage}</div>}
    </div>
  );
}
