import { App, Button, Image, Tag, theme } from 'antd';
import { ArrowUp, GripHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import { useDrawingStore } from '@/stores/drawingStore';
import type { DrawingImage, DrawingSettings } from '@/types';

interface Props {
  settings: DrawingSettings;
  prompt: string;
  onPromptChange: (value: string) => void;
  onHeightChange?: (height: number) => void;
}

const TEXTAREA_MIN_HEIGHT = 72;
const TEXTAREA_MAX_HEIGHT = 260;

function clampTextareaHeight(value: number) {
  return Math.min(TEXTAREA_MAX_HEIGHT, Math.max(TEXTAREA_MIN_HEIGHT, value));
}

function DrawingEditPreview({ image, previewUrl }: { image: DrawingImage; previewUrl: string | null }) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [src, setSrc] = useState<string | null>(previewUrl);

  useEffect(() => {
    if (previewUrl) {
      setSrc(previewUrl);
      return undefined;
    }

    let cancelled = false;
    setSrc(null);
    invoke<string>('read_attachment_preview', { filePath: image.storage_path })
      .then((data) => { if (!cancelled) setSrc(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [image.storage_path, previewUrl]);

  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md"
      style={{
        background: token.colorFillAlter,
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      {src ? (
        <Image
          src={src}
          alt={t('drawing.editPreview', '编辑预览')}
          width={36}
          height={36}
          style={{
            display: 'block',
            width: 36,
            height: 36,
            objectFit: 'cover',
            borderRadius: 6,
          }}
          preview={{ mask: { blur: true }, scaleStep: 0.5 }}
        />
      ) : null}
    </div>
  );
}

export function DrawingComposer({ settings, prompt, onPromptChange, onHeightChange }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const references = useDrawingStore((s) => s.references);
  const editSourceImage = useDrawingStore((s) => s.editSourceImage);
  const editMaskFileId = useDrawingStore((s) => s.editMaskFileId);
  const editMaskFile = useDrawingStore((s) => s.editMaskFile);
  const editPreviewUrl = useDrawingStore((s) => s.editPreviewUrl);
  const selectImageForEdit = useDrawingStore((s) => s.selectImageForEdit);
  const generateImages = useDrawingStore((s) => s.generateImages);
  const editImage = useDrawingStore((s) => s.editImage);
  const editImageWithMask = useDrawingStore((s) => s.editImageWithMask);
  const submitting = useDrawingStore((s) => s.submitting);
  const [textareaHeight, setTextareaHeight] = useState(TEXTAREA_MIN_HEIGHT);
  const [resizing, setResizing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStateRef.current = {
      startY: event.clientY,
      startHeight: textareaHeight,
    };
    setResizing(true);
  }, [textareaHeight]);

  useEffect(() => {
    if (!resizing) return undefined;

    const handlePointerMove = (event: PointerEvent) => {
      const state = resizeStateRef.current;
      if (!state) return;
      setTextareaHeight(clampTextareaHeight(state.startHeight + state.startY - event.clientY));
    };

    const handlePointerUp = () => {
      resizeStateRef.current = null;
      setResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [resizing]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || !onHeightChange) return undefined;

    const reportHeight = () => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height > 0) onHeightChange(height);
    };

    reportHeight();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [onHeightChange, textareaHeight, editSourceImage, editMaskFileId]);

  const handleSubmit = async () => {
    if (!settings.providerId) {
      message.warning(t('drawing.selectProvider', '选择 OpenAI Provider'));
      return;
    }
    const promptText = prompt.trim();
    if (!promptText) {
      message.warning(t('drawing.promptRequired', '请输入提示词'));
      return;
    }
    try {
      const base = {
        provider_id: settings.providerId,
        model_id: settings.modelId,
        prompt: promptText,
        size: settings.size,
        quality: settings.quality,
        output_format: settings.outputFormat,
        background: settings.background,
        output_compression: settings.outputCompression,
        n: settings.n,
        reference_file_ids: references.map((item) => item.id),
      };
      onPromptChange('');
      if (editSourceImage && editMaskFileId) {
        await editImageWithMask({
          ...base,
          source_image_id: editSourceImage.id,
          mask_file_id: editMaskFile?.id ?? editMaskFileId,
        });
      } else if (editSourceImage) {
        await editImage({ ...base, source_image_id: editSourceImage.id });
      } else {
        await generateImages(base);
      }
    } catch (e) {
      message.error(String(e));
    }
  };

  return (
    <div
      ref={rootRef}
      className="absolute bottom-0 left-0 right-0 z-10 px-[10px] pb-5 pt-3"
      style={{
        backgroundColor: token.colorBgContainer,
      }}
    >
      <div
        data-testid="drawing-composer"
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: 16,
          backgroundColor: token.colorBgContainer,
          overflow: 'hidden',
        }}
      >
        <div
          data-testid="drawing-composer-resize-handle"
          onPointerDown={handleResizeStart}
          style={{
            height: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            cursor: 'ns-resize',
            userSelect: 'none',
            touchAction: 'none',
          }}
        >
          <GripHorizontal size={14} style={{ color: token.colorTextQuaternary, opacity: 0.5 }} />
        </div>
        {editSourceImage && (
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <DrawingEditPreview image={editSourceImage} previewUrl={editPreviewUrl} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Tag color={editMaskFileId ? 'green' : 'blue'} style={{ width: 'fit-content', marginInlineEnd: 0 }}>
                {editMaskFileId ? t('drawing.maskEditMode', '区域编辑模式') : t('drawing.editMode', '编辑模式')}
              </Tag>
              <span className="min-w-0 truncate" style={{ fontSize: 12, color: token.colorTextSecondary }}>
                {editSourceImage.storage_path}
              </span>
            </div>
            <Button size="small" type="text" icon={<X size={14} />} onClick={() => selectImageForEdit(null)} />
          </div>
        )}
        <textarea
          className="aqbot-input-textarea"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key === 'Process') return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t('drawing.promptPlaceholder', '输入你想生成的画面')}
          rows={2}
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            resize: 'none',
            padding: '4px 16px 8px',
            fontSize: token.fontSize,
            lineHeight: 1.6,
            backgroundColor: 'transparent',
            color: token.colorText,
            fontFamily: 'inherit',
            minHeight: TEXTAREA_MIN_HEIGHT,
            height: textareaHeight,
            maxHeight: TEXTAREA_MAX_HEIGHT,
            overflowY: 'auto',
          }}
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <div />
          <Button
            type="primary"
            shape="circle"
            size="small"
            icon={<ArrowUp size={14} />}
            loading={submitting}
            disabled={!prompt.trim()}
            onClick={handleSubmit}
          />
        </div>
      </div>
    </div>
  );
}
