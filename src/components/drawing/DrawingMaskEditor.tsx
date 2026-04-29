import { App, Button, Modal, Slider, Space, theme } from 'antd';
import { Eraser, RotateCcw, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import type { DrawingImage, DrawingStoredFile } from '@/types';

interface Props {
  open: boolean;
  image: DrawingImage | null;
  onApply: (image: DrawingImage, maskFile: DrawingStoredFile, previewUrl: string | null) => void;
  onClose: () => void;
}

const MASK_MODAL_EDGE_GAP = 24;
const MASK_MODAL_WIDTH = `min(1080px, calc(100vw - ${MASK_MODAL_EDGE_GAP * 2}px))`;
const MASK_MODAL_BODY_MAX_HEIGHT = 'calc(100vh - 160px)';
const MASK_EDITOR_SURFACE_MAX_HEIGHT = 'calc(100vh - 220px)';
const MASK_PAINT_ALPHA = 0.42;
const MASK_ERASER_ALPHA = 1;
const MASK_ERASER_FEEDBACK_ALPHA = 0.24;
const MASK_ERASER_FEEDBACK_CLEAR_DELAY = 420;

export function getMaskBrushStyle(erasing: boolean): {
  compositeOperation: GlobalCompositeOperation;
  fillStyle: string;
  globalAlpha: number;
};
export function getMaskBrushStyle(erasing: boolean, themeColor: string): {
  compositeOperation: GlobalCompositeOperation;
  fillStyle: string;
  globalAlpha: number;
};
export function getMaskBrushStyle(erasing: boolean, themeColor = '#1677ff') {
  return {
    compositeOperation: erasing ? 'destination-out' : 'source-over',
    fillStyle: erasing ? '#000000' : themeColor,
    globalAlpha: erasing ? MASK_ERASER_ALPHA : MASK_PAINT_ALPHA,
  };
}

export function getEraserFeedbackStyle(themeColor = '#1677ff'): {
  compositeOperation: GlobalCompositeOperation;
  fillStyle: string;
  globalAlpha: number;
} {
  return {
    compositeOperation: 'source-over',
    fillStyle: themeColor,
    globalAlpha: MASK_ERASER_FEEDBACK_ALPHA,
  };
}

export function overlayAlphaToMaskAlpha(alpha: number): number {
  return alpha > 0 ? 0 : 255;
}

export function DrawingMaskEditor({ open, image, onApply, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const feedbackCanvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const erasingRef = useRef(false);
  const feedbackTimerRef = useRef<number | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [brushSize, setBrushSize] = useState(36);
  const [erasing, setErasing] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [history, setHistory] = useState<string[]>([]);

  const clearFeedback = () => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    const feedbackCanvas = feedbackCanvasRef.current;
    feedbackCanvas?.getContext('2d')?.clearRect(0, 0, feedbackCanvas.width, feedbackCanvas.height);
  };

  const scheduleFeedbackClear = () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      const feedbackCanvas = feedbackCanvasRef.current;
      feedbackCanvas?.getContext('2d')?.clearRect(0, 0, feedbackCanvas.width, feedbackCanvas.height);
    }, MASK_ERASER_FEEDBACK_CLEAR_DELAY);
  };

  useEffect(() => {
    if (open) return;
    setSrc(null);
    setHistory([]);
    setErasing(false);
    erasingRef.current = false;
    setDrawing(false);
    imgRef.current = null;
    const maskCanvas = maskCanvasRef.current;
    maskCanvas?.getContext('2d')?.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    clearFeedback();
  }, [open]);

  useEffect(() => {
    if (!open || !image) return;
    let cancelled = false;
    invoke<string>('read_attachment_preview', { filePath: image.storage_path })
      .then((data) => { if (!cancelled) setSrc(data); })
      .catch((e) => message.error(String(e)));
    return () => { cancelled = true; };
  }, [open, image, message]);

  useEffect(() => {
    if (!src || !maskCanvasRef.current) return;
    const img = new Image();
    img.onload = () => {
      const maskCanvas = maskCanvasRef.current;
      const feedbackCanvas = feedbackCanvasRef.current;
      if (!maskCanvas) return;
      maskCanvas.width = img.naturalWidth;
      maskCanvas.height = img.naturalHeight;
      if (feedbackCanvas) {
        feedbackCanvas.width = img.naturalWidth;
        feedbackCanvas.height = img.naturalHeight;
      }
      const ctx = maskCanvas.getContext('2d');
      ctx?.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      clearFeedback();
      imgRef.current = img;
      setHistory([]);
    };
    img.src = src;
  }, [src]);

  const pointerPoint = (event: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const drawCircle = (
    ctx: CanvasRenderingContext2D,
    point: { x: number; y: number },
    style: ReturnType<typeof getMaskBrushStyle>,
  ) => {
    ctx.save();
    ctx.globalCompositeOperation = style.compositeOperation;
    ctx.globalAlpha = style.globalAlpha;
    ctx.fillStyle = style.fillStyle;
    ctx.beginPath();
    ctx.arc(point.x, point.y, brushSize, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const drawEraserFeedback = (point: { x: number; y: number }) => {
    const feedbackCanvas = feedbackCanvasRef.current;
    if (!feedbackCanvas) return;
    const ctx = feedbackCanvas.getContext('2d');
    if (!ctx) return;
    drawCircle(ctx, point, getEraserFeedbackStyle(token.colorPrimary));
  };

  const drawAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const ctx = maskCanvas.getContext('2d');
    if (!ctx) return;
    const point = pointerPoint(event, maskCanvas);
    const isErasing = erasingRef.current;
    drawCircle(ctx, point, getMaskBrushStyle(isErasing, token.colorPrimary));
    if (isErasing) drawEraserFeedback(point);
  };

  const exportMaskPreviewUrl = () => {
    const overlay = maskCanvasRef.current;
    const image = imgRef.current;
    if (!overlay || !image) return src;
    const preview = document.createElement('canvas');
    preview.width = overlay.width;
    preview.height = overlay.height;
    const previewCtx = preview.getContext('2d');
    if (!previewCtx) return src;
    previewCtx.save();
    previewCtx.drawImage(image, 0, 0, overlay.width, overlay.height);
    previewCtx.drawImage(overlay, 0, 0);
    previewCtx.restore();
    return preview.toDataURL('image/png');
  };

  const exportMaskBase64 = () => {
    const overlay = maskCanvasRef.current;
    if (!overlay) throw new Error('Mask canvas is not ready');
    const mask = document.createElement('canvas');
    mask.width = overlay.width;
    mask.height = overlay.height;
    const maskCtx = mask.getContext('2d');
    if (!maskCtx) throw new Error('Cannot create mask canvas');
    const overlayCtx = overlay.getContext('2d');
    if (!overlayCtx) throw new Error('Cannot read mask overlay');
    const source = overlayCtx.getImageData(0, 0, overlay.width, overlay.height);
    const output = maskCtx.createImageData(mask.width, mask.height);
    for (let index = 0; index < source.data.length; index += 4) {
      output.data[index] = 255;
      output.data[index + 1] = 255;
      output.data[index + 2] = 255;
      output.data[index + 3] = overlayAlphaToMaskAlpha(source.data[index + 3]);
    }
    maskCtx.putImageData(output, 0, 0);
    return mask.toDataURL('image/png').split(',')[1] || '';
  };

  const handleSubmit = async () => {
    if (!image) return;
    try {
      const data = exportMaskBase64();
      const mask = await invoke<DrawingStoredFile>('upload_drawing_reference', {
        input: {
          data,
          file_name: `mask-${image.id}.png`,
          mime_type: 'image/png',
        },
      });
      onApply(image, mask, exportMaskPreviewUrl());
    } catch (e) {
      message.error(String(e));
    }
  };

  return (
    <Modal
      open={open}
      title={t('drawing.maskEdit', '区域编辑')}
      width={MASK_MODAL_WIDTH}
      style={{
        top: MASK_MODAL_EDGE_GAP,
        maxWidth: `calc(100vw - ${MASK_MODAL_EDGE_GAP * 2}px)`,
        paddingBottom: MASK_MODAL_EDGE_GAP,
      }}
      onCancel={onClose}
      onOk={handleSubmit}
      okText={t('drawing.submitMaskEdit', '提交区域编辑')}
      styles={{
        mask: { backdropFilter: 'blur(4px)' },
        body: {
          maxHeight: MASK_MODAL_BODY_MAX_HEIGHT,
          overflow: 'hidden',
        },
      }}
    >
      <div className="flex gap-4 overflow-hidden" style={{ maxHeight: MASK_MODAL_BODY_MAX_HEIGHT }}>
        <div
          data-testid="drawing-mask-editor-surface"
          className="flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md"
          style={{
            background: token.colorFillAlter,
            maxHeight: MASK_EDITOR_SURFACE_MAX_HEIGHT,
            overflow: 'hidden',
          }}
        >
          <div
            className="relative"
            style={{
              width: 'fit-content',
              height: 'fit-content',
              maxWidth: '100%',
              maxHeight: MASK_EDITOR_SURFACE_MAX_HEIGHT,
            }}
          >
            {src && (
              <img
                src={src}
                alt=""
                style={{
                  display: 'block',
                  width: 'auto',
                  height: 'auto',
                  maxWidth: '100%',
                  maxHeight: MASK_EDITOR_SURFACE_MAX_HEIGHT,
                  objectFit: 'contain',
                }}
              />
            )}
            <canvas
              ref={maskCanvasRef}
              className="absolute inset-0"
              style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
            />
            <canvas
              ref={feedbackCanvasRef}
              className="absolute inset-0 cursor-crosshair"
              style={{ width: '100%', height: '100%', touchAction: 'none' }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture?.(event.pointerId);
                const canvas = maskCanvasRef.current;
                if (canvas) {
                  setHistory((items) => [...items.slice(-12), canvas.toDataURL('image/png')]);
                }
                if (erasingRef.current) clearFeedback();
                setDrawing(true);
                drawAt(event);
              }}
              onPointerMove={(event) => { if (drawing) drawAt(event); }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture?.(event.pointerId);
                setDrawing(false);
                if (erasingRef.current) scheduleFeedbackClear();
              }}
              onPointerCancel={() => {
                setDrawing(false);
                if (erasingRef.current) scheduleFeedbackClear();
              }}
              onPointerLeave={() => {
                setDrawing(false);
                if (erasingRef.current) scheduleFeedbackClear();
              }}
            />
          </div>
        </div>
        <div className="shrink-0 overflow-hidden" style={{ width: 180, maxHeight: MASK_EDITOR_SURFACE_MAX_HEIGHT }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button
              block
              type={erasing ? 'primary' : 'default'}
              icon={<Eraser size={16} />}
              onClick={() => setErasing((value) => {
                const next = !value;
                erasingRef.current = next;
                if (!next) clearFeedback();
                return next;
              })}
            >
              {t('drawing.eraser', '橡皮')}
            </Button>
            <Button
              block
              icon={<Undo2 size={16} />}
              disabled={history.length === 0}
              onClick={() => {
                const last = history[history.length - 1];
                const canvas = maskCanvasRef.current;
                const ctx = canvas?.getContext('2d');
                if (!last || !canvas || !ctx) return;
                clearFeedback();
                const img = new Image();
                img.onload = () => {
                  ctx.clearRect(0, 0, canvas.width, canvas.height);
                  ctx.drawImage(img, 0, 0);
                };
                img.src = last;
                setHistory((items) => items.slice(0, -1));
              }}
            >
              {t('drawing.undo', '撤销')}
            </Button>
            <Button
              block
              icon={<RotateCcw size={16} />}
              onClick={() => {
                const canvas = maskCanvasRef.current;
                canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
                clearFeedback();
                setHistory([]);
              }}
            >
              {t('drawing.reset', '重置')}
            </Button>
            <div>
              <div style={{ fontSize: 12, color: token.colorTextSecondary }}>{t('drawing.brushSize', '画笔大小')}</div>
              <Slider min={4} max={96} value={brushSize} onChange={setBrushSize} />
            </div>
          </Space>
        </div>
      </div>
    </Modal>
  );
}
