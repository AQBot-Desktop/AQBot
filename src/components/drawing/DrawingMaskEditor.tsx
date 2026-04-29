import { App, Button, Modal, Slider, Space, theme } from 'antd';
import { Eraser, RotateCcw, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import { useDrawingStore } from '@/stores/drawingStore';
import type { DrawingImage } from '@/types';
import type { DrawingSettings } from './DrawingSettingsPanel';

interface Props {
  open: boolean;
  image: DrawingImage | null;
  prompt: string;
  settings: DrawingSettings;
  onClose: () => void;
}

export function DrawingMaskEditor({ open, image, prompt, settings, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [brushSize, setBrushSize] = useState(36);
  const [erasing, setErasing] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const editImageWithMask = useDrawingStore((s) => s.editImageWithMask);
  const references = useDrawingStore((s) => s.references);

  useEffect(() => {
    if (!open || !image) return;
    let cancelled = false;
    invoke<string>('read_attachment_preview', { filePath: image.storage_path })
      .then((data) => { if (!cancelled) setSrc(data); })
      .catch((e) => message.error(String(e)));
    return () => { cancelled = true; };
  }, [open, image, message]);

  useEffect(() => {
    if (!src || !canvasRef.current) return;
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      imgRef.current = img;
      setHistory([]);
    };
    img.src = src;
  }, [src]);

  const pointerPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const drawAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const point = pointerPoint(event);
    ctx.save();
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    ctx.fillStyle = 'rgba(22, 119, 255, 0.42)';
    ctx.beginPath();
    ctx.arc(point.x, point.y, brushSize, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const exportMaskBase64 = () => {
    const overlay = canvasRef.current;
    if (!overlay) throw new Error('Mask canvas is not ready');
    const mask = document.createElement('canvas');
    mask.width = overlay.width;
    mask.height = overlay.height;
    const maskCtx = mask.getContext('2d');
    if (!maskCtx) throw new Error('Cannot create mask canvas');
    maskCtx.fillStyle = '#ffffff';
    maskCtx.fillRect(0, 0, mask.width, mask.height);
    maskCtx.globalCompositeOperation = 'destination-out';
    maskCtx.drawImage(overlay, 0, 0);
    return mask.toDataURL('image/png').split(',')[1] || '';
  };

  const handleSubmit = async () => {
    if (!image) return;
    try {
      const data = exportMaskBase64();
      const mask = await invoke<{ id: string }>('upload_drawing_reference', {
        input: {
          data,
          file_name: `mask-${image.id}.png`,
          mime_type: 'image/png',
        },
      });
      await editImageWithMask({
        provider_id: settings.providerId,
        model_id: settings.modelId,
        prompt,
        size: settings.size,
        quality: settings.quality,
        output_format: settings.outputFormat,
        background: settings.background,
        output_compression: settings.outputCompression,
        n: settings.n,
        source_image_id: image.id,
        mask_file_id: mask.id,
        reference_file_ids: references.map((item) => item.id),
      });
      onClose();
    } catch (e) {
      message.error(String(e));
    }
  };

  return (
    <Modal
      open={open}
      title={t('drawing.maskEdit', '区域编辑')}
      width={960}
      onCancel={onClose}
      onOk={handleSubmit}
      okText={t('drawing.submitMaskEdit', '提交区域编辑')}
      styles={{ mask: { backdropFilter: 'blur(4px)' } }}
    >
      <div className="flex gap-4">
        <div className="relative flex-1 overflow-hidden rounded-md" style={{ background: token.colorFillAlter }}>
          {src && <img src={src} alt="" style={{ width: '100%', display: 'block' }} />}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full cursor-crosshair"
            onPointerDown={(event) => {
              const canvas = canvasRef.current;
              if (canvas) {
                setHistory((items) => [...items.slice(-12), canvas.toDataURL('image/png')]);
              }
              setDrawing(true);
              drawAt(event);
            }}
            onPointerMove={(event) => { if (drawing) drawAt(event); }}
            onPointerUp={() => setDrawing(false)}
            onPointerLeave={() => setDrawing(false)}
          />
        </div>
        <div style={{ width: 180 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button
              block
              type={erasing ? 'primary' : 'default'}
              icon={<Eraser size={16} />}
              onClick={() => setErasing((value) => !value)}
            >
              {t('drawing.eraser', '橡皮')}
            </Button>
            <Button
              block
              icon={<Undo2 size={16} />}
              disabled={history.length === 0}
              onClick={() => {
                const last = history[history.length - 1];
                const canvas = canvasRef.current;
                const ctx = canvas?.getContext('2d');
                if (!last || !canvas || !ctx) return;
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
                const canvas = canvasRef.current;
                canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
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
