import { App, Button, Tag, theme } from 'antd';
import { ArrowUp, GripHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDrawingStore } from '@/stores/drawingStore';
import type { DrawingSettings } from './DrawingSettingsPanel';

interface Props {
  settings: DrawingSettings;
  prompt: string;
  onPromptChange: (value: string) => void;
}

export function DrawingComposer({ settings, prompt, onPromptChange }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const references = useDrawingStore((s) => s.references);
  const editSourceImage = useDrawingStore((s) => s.editSourceImage);
  const selectImageForEdit = useDrawingStore((s) => s.selectImageForEdit);
  const generateImages = useDrawingStore((s) => s.generateImages);
  const editImage = useDrawingStore((s) => s.editImage);
  const submitting = useDrawingStore((s) => s.submitting);

  const handleSubmit = async () => {
    if (!settings.providerId) {
      message.warning(t('drawing.selectProvider', '选择 OpenAI Provider'));
      return;
    }
    if (!prompt.trim()) {
      message.warning(t('drawing.promptRequired', '请输入提示词'));
      return;
    }
    try {
      const base = {
        provider_id: settings.providerId,
        model_id: settings.modelId,
        prompt: prompt.trim(),
        size: settings.size,
        quality: settings.quality,
        output_format: settings.outputFormat,
        background: settings.background,
        output_compression: settings.outputCompression,
        n: settings.n,
        reference_file_ids: references.map((item) => item.id),
      };
      if (editSourceImage) {
        await editImage({ ...base, source_image_id: editSourceImage.id });
      } else {
        await generateImages(base);
      }
      onPromptChange('');
    } catch (e) {
      message.error(String(e));
    }
  };

  return (
    <div
      className="absolute bottom-5 left-1/2 z-10 w-[min(760px,calc(100%-48px))] -translate-x-1/2"
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
          style={{
            height: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <GripHorizontal size={14} style={{ color: token.colorTextQuaternary, opacity: 0.5 }} />
        </div>
        {editSourceImage && (
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <Tag color="blue">{t('drawing.editMode', '编辑模式')}</Tag>
            <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, color: token.colorTextSecondary }}>
              {editSourceImage.storage_path}
            </span>
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
            minHeight: 72,
            maxHeight: 180,
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
