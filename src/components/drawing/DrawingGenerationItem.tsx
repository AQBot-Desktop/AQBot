import { Button, Dropdown, Image, Tooltip, Tag, Typography, message, theme } from 'antd';
import { Clipboard, Download, FolderOpen, Focus, Pencil, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DrawingGeneration, DrawingImage } from '@/types';
import { describeDrawingSize } from '@/lib/drawingModels';
import { CopyButton } from '@/components/common/CopyButton';
import { invoke } from '@/lib/invoke';
import { copyChatImage, saveChatImage } from '@/lib/chatImageActions';
import { DrawingImageStrip } from './DrawingImageStrip';

interface Props {
  generation: DrawingGeneration;
  onEdit: (image: DrawingImage) => void;
  onMaskEdit: (image: DrawingImage) => void;
  onRetry: (generation: DrawingGeneration) => void;
  onDelete: (id: string, deleteResources: boolean) => void;
  onUsePrompt: (prompt: string) => void;
}

function parseParams(generation: DrawingGeneration): Record<string, any> {
  try {
    return JSON.parse(generation.parameters_json || '{}');
  } catch {
    return {};
  }
}

function describeQuality(value: string | undefined, t: (key: string, fallback: string) => string) {
  if (value === 'low') return t('drawing.option.quality.low', '低');
  if (value === 'medium') return t('drawing.option.quality.medium', '中');
  if (value === 'high') return t('drawing.option.quality.high', '高');
  return t('drawing.option.auto', '自动');
}

function describeFormat(value: string | undefined) {
  return (value || 'png').toUpperCase();
}

function describeBackground(value: string | undefined, t: (key: string, fallback: string) => string) {
  if (value === 'opaque') return t('drawing.option.background.opaque', '不透明');
  if (value === 'transparent') return t('drawing.option.background.transparent', '透明');
  return t('drawing.option.auto', '自动');
}

function describeAction(action: DrawingGeneration['action'], t: (key: string, fallback: string) => string) {
  if (action === 'reference_generate') return t('drawing.action.referenceGenerate', '参考图生成');
  if (action === 'edit') return t('drawing.action.edit', '编辑');
  if (action === 'mask_edit') return t('drawing.action.maskEdit', '区域编辑');
  return t('drawing.action.generate', '文本生成');
}

function describeSize(value: string | undefined, t: (key: string, fallback: string) => string) {
  if (!value || value === 'auto') return t('drawing.option.auto', '自动');
  return describeDrawingSize(value);
}

function DrawingContextThumbnail({ filePath, label }: { filePath: string; label: string }) {
  const { token } = theme.useToken();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    invoke<string>('read_attachment_preview', { filePath })
      .then((data) => { if (!cancelled) setSrc(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [filePath]);

  return (
    <Tooltip title={label}>
      <span
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md align-middle"
        style={{
          background: token.colorFillAlter,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {src ? (
          <Image
            src={src}
            alt={label}
            width={32}
            height={32}
            style={{
              display: 'block',
              width: 32,
              height: 32,
              objectFit: 'cover',
              borderRadius: 6,
            }}
            preview={{ mask: { blur: true }, scaleStep: 0.5 }}
          />
        ) : null}
      </span>
    </Tooltip>
  );
}

export function DrawingGenerationItem({
  generation,
  onEdit,
  onMaskEdit,
  onRetry,
  onDelete,
  onUsePrompt,
}: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const params = parseParams(generation);
  const firstImage = generation.images[0];
  const placeholderCount = Number(params.n || generation.images.length || 1);
  const contextThumbnails = useMemo(() => [
    ...(generation.source_images ?? []).map((image, index) => ({
      key: `source-${image.id}`,
      filePath: image.storage_path,
      label: t('drawing.sourceImageWithIndex', `原图 ${index + 1}`),
    })),
    ...(generation.mask_file ? [{
      key: `mask-${generation.mask_file.id}`,
      filePath: generation.mask_file.storage_path,
      label: t('drawing.maskImage', 'Mask 图'),
    }] : []),
    ...(generation.reference_files ?? []).map((file, index) => ({
      key: `ref-${file.id}`,
      filePath: file.storage_path,
      label: t('drawing.referenceImageWithIndex', `参考图 ${index + 1}`),
    })),
  ], [generation.mask_file, generation.reference_files, generation.source_images, t]);
  const metadata = [
    { label: t('drawing.meta.action', '类型'), value: describeAction(generation.action, t) },
    { label: t('drawing.meta.model', '模型'), value: generation.model_id },
    { label: t('drawing.meta.size', '尺寸'), value: describeSize(params.size, t) },
    { label: t('drawing.meta.quality', '质量'), value: describeQuality(params.quality, t) },
    { label: t('drawing.meta.format', '格式'), value: describeFormat(params.output_format) },
    { label: t('drawing.meta.background', '背景'), value: describeBackground(params.background, t) },
    { label: t('drawing.meta.count', '张数'), value: String(placeholderCount) },
  ];

  const resolveFirstImagePreview = async () => {
    if (!firstImage) throw new Error('No image to operate on.');
    return invoke<string>('read_attachment_preview', { filePath: firstImage.storage_path });
  };

  const handleRevealImage = async () => {
    if (!firstImage) return;
    try {
      await invoke('reveal_attachment_file', { filePath: firstImage.storage_path });
    } catch (error) {
      message.error(String(error));
    }
  };

  const handleSaveImage = async () => {
    if (!firstImage) return;
    try {
      const src = await resolveFirstImagePreview();
      await saveChatImage(src, firstImage.storage_path.split('/').pop() || 'drawing.png');
    } catch (error) {
      message.error(String(error));
    }
  };

  const handleCopyImage = async () => {
    if (!firstImage) return;
    try {
      const src = await resolveFirstImagePreview();
      await copyChatImage(src);
      message.success(t('common.copySuccess', '已复制到剪贴板'));
    } catch (error) {
      message.error(String(error));
    }
  };

  return (
    <section
      style={{
        padding: '20px 24px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
      }}
    >
      <div className="mb-3 flex flex-col gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {contextThumbnails.map((item) => (
              <DrawingContextThumbnail
                key={item.key}
                filePath={item.filePath}
                label={item.label}
              />
            ))}
            <span className="drawing-prompt-line">
              <span
                role="button"
                tabIndex={0}
                className="drawing-prompt-trigger rounded-md"
                aria-label={t('drawing.usePrompt', '使用提示词')}
                onClick={() => onUsePrompt(generation.prompt)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onUsePrompt(generation.prompt);
                }}
                style={{
                  '--drawing-prompt-hover-bg': token.colorFillSecondary,
                } as CSSProperties}
              >
                <Typography.Text style={{ fontSize: 14, lineHeight: 1.65 }}>
                  {generation.prompt}
                </Typography.Text>
              </span>
            </span>
            <Tooltip title={t('drawing.copyPrompt', '复制提示词')}>
              <CopyButton
                className="drawing-prompt-copy"
                text={generation.prompt}
                successMessage={t('common.copySuccess', '已复制到剪贴板')}
              />
            </Tooltip>
            <span className="ml-2 inline-flex align-middle">
              {generation.status === 'failed' && (
                <Tag color="error" style={{ marginTop: 3 }}>{t('drawing.failed', '失败')}</Tag>
              )}
              {generation.status === 'running' && (
                <Tag color="processing" style={{ marginTop: 3 }}>{t('drawing.generating', '生成中')}</Tag>
              )}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {metadata.map((item) => (
            <span
              key={item.label}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1"
              style={{
                background: token.colorFillAlter,
                border: `1px solid ${token.colorBorderSecondary}`,
                color: token.colorTextSecondary,
                fontSize: 12,
                lineHeight: '16px',
              }}
            >
              <span>{item.label}</span>
              <span style={{ color: token.colorText, fontWeight: 500 }}>{item.value}</span>
            </span>
          ))}
        </div>
      </div>

      {generation.error_message ? (
        <div
          className="flex items-start gap-2 rounded-md px-3 py-2"
          style={{
            background: token.colorErrorBg,
            border: `1px solid ${token.colorErrorBorder}`,
          }}
        >
          <Typography.Text type="danger" className="min-w-0 flex-1" style={{ whiteSpace: 'pre-wrap' }}>
            {generation.error_message}
          </Typography.Text>
          <CopyButton
            className="drawing-error-copy"
            text={generation.error_message}
            successMessage={t('common.copySuccess', '已复制到剪贴板')}
          />
        </div>
      ) : (
        <DrawingImageStrip
          images={generation.images}
          loading={generation.status === 'running'}
          placeholderCount={placeholderCount}
        />
      )}

      {generation.status !== 'running' && (
        <div className="mt-4 flex gap-2">
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'reveal',
                  icon: <FolderOpen size={14} />,
                  label: t('drawing.openOriginalDirectory', '打开原图目录'),
                },
                {
                  key: 'save',
                  icon: <Save size={14} />,
                  label: t('drawing.saveAs', '另存为'),
                },
                {
                  key: 'copy',
                  icon: <Clipboard size={14} />,
                  label: t('drawing.copyToClipboard', '复制到剪切板'),
                },
              ],
              onClick: ({ key }) => {
                if (key === 'reveal') void handleRevealImage();
                if (key === 'save') void handleSaveImage();
                if (key === 'copy') void handleCopyImage();
              },
            }}
          >
            <Tooltip title={t('drawing.download', '下载')}>
              <Button
                aria-label={t('drawing.download', '下载')}
                size="small"
                color="default"
                variant="filled"
                icon={<Download size={15} />}
                disabled={!firstImage}
              />
            </Tooltip>
          </Dropdown>
          <Tooltip title={t('drawing.reEdit', '重新编辑')}>
            <Button
              aria-label={t('drawing.reEdit', '重新编辑')}
              size="small"
              color="default"
              variant="filled"
              icon={<Pencil size={15} />}
              disabled={!firstImage}
              onClick={() => firstImage && onEdit(firstImage)}
            />
          </Tooltip>
          <Tooltip title={t('drawing.maskEdit', '区域编辑')}>
            <Button
              aria-label={t('drawing.maskEdit', '区域编辑')}
              size="small"
              color="default"
              variant="filled"
              icon={<Focus size={15} />}
              disabled={!firstImage}
              onClick={() => firstImage && onMaskEdit(firstImage)}
            />
          </Tooltip>
          <Tooltip title={t('drawing.regenerate', '再次生成')}>
            <Button
              aria-label={t('drawing.regenerate', '再次生成')}
              size="small"
              color="default"
              variant="filled"
              icon={<RefreshCw size={15} />}
              onClick={() => onRetry(generation)}
            />
          </Tooltip>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'record',
                  label: t('drawing.deleteRecordOnly', '仅删除记录'),
                },
                {
                  key: 'all',
                  label: t('drawing.deleteRecordAndImages', '全部删除'),
                  danger: true,
                },
              ],
              onClick: ({ key }) => {
                if (key === 'record') onDelete(generation.id, false);
                if (key === 'all') onDelete(generation.id, true);
              },
            }}
          >
            <Tooltip title={t('drawing.deleteRecord', '删除')}>
              <Button
                aria-label={t('drawing.deleteRecord', '删除')}
                size="small"
                color="danger"
                variant="filled"
                icon={<Trash2 size={15} />}
              />
            </Tooltip>
          </Dropdown>
        </div>
      )}
    </section>
  );
}
