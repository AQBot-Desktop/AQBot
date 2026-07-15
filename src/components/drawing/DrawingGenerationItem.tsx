import { Button, Dropdown, Image, Popconfirm, Tooltip, Tag, Typography, message, theme } from 'antd';
import { AtSign, CircleStop, Clipboard, Download, Focus, FolderOpen, Pencil, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DrawingGeneration, DrawingImage } from '@/types';
import { describeDrawingSize } from '@/lib/drawingModels';
import { CopyButton } from '@/components/common/CopyButton';
import { invoke } from '@/lib/invoke';
import { copyChatImage, saveChatImage } from '@/lib/chatImageActions';
import { loadStoredMediaSource } from '@/lib/storedMedia';
import { DrawingImageStrip } from './DrawingImageStrip';
import { usePageTransientOpenState } from '@/components/layout/PageLifecycle';

interface Props {
  generation: DrawingGeneration;
  onEdit: (image: DrawingImage) => void;
  onMaskEdit: (image: DrawingImage) => void;
  onRetry: (generation: DrawingGeneration) => void;
  onStop?: (id: string) => void;
  onDelete: (id: string, deleteResources: boolean) => void;
  onUsePrompt: (prompt: string) => void;
  onUseAsReference?: (image: DrawingImage) => void;
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

const CONTEXT_THUMBNAIL_SIZE = 32;

function DrawingContextThumbnail({
  storedFileId,
  filePath,
  label,
}: {
  storedFileId: string;
  filePath: string;
  label: string;
}) {
  const { token } = theme.useToken();
  const [src, setSrc] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = usePageTransientOpenState();

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    loadStoredMediaSource(storedFileId, filePath)
      .then((data) => { if (!cancelled) setSrc(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [filePath, storedFileId]);

  return (
    <Tooltip title={label}>
      <span
        className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md align-middle"
        style={{
          width: CONTEXT_THUMBNAIL_SIZE,
          height: CONTEXT_THUMBNAIL_SIZE,
          background: token.colorFillAlter,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {src ? (
          <Image
            src={src}
            alt={label}
            width={CONTEXT_THUMBNAIL_SIZE}
            height={CONTEXT_THUMBNAIL_SIZE}
            style={{
              display: 'block',
              width: CONTEXT_THUMBNAIL_SIZE,
              height: CONTEXT_THUMBNAIL_SIZE,
              objectFit: 'cover',
              borderRadius: 6,
            }}
            preview={{
              open: previewOpen,
              onOpenChange: setPreviewOpen,
              mask: { blur: true },
              scaleStep: 0.5,
            }}
          />
        ) : null}
      </span>
    </Tooltip>
  );
}

function DrawingImageMenuLabel({ image, label }: { image: DrawingImage; label: string }) {
  const { token } = theme.useToken();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadStoredMediaSource(image.stored_file_id, image.storage_path)
      .then((data) => { if (!cancelled) setSrc(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [image.storage_path, image.stored_file_id]);

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded"
        style={{
          background: token.colorFillAlter,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {src ? (
          <img
            src={src}
            alt={label}
            className="block h-full w-full object-cover"
          />
        ) : null}
      </span>
      <span>{label}</span>
    </span>
  );
}

export function DrawingGenerationItem({
  generation,
  onEdit,
  onMaskEdit,
  onRetry,
  onStop,
  onDelete,
  onUsePrompt,
  onUseAsReference,
}: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const params = parseParams(generation);
  const firstImage = generation.images[0];
  const hasGeneratedImages = generation.images.length > 0;
  const isRunning = generation.status === 'running';
  const isStopped = generation.status === 'stopped';
  const placeholderCount = Number(params.n || generation.images.length || 1);
  const hasMultipleImages = generation.images.length > 1;
  const imageMenuItems = useMemo(() => generation.images.map((image, index) => ({
    key: image.id,
    label: (
      <DrawingImageMenuLabel
        image={image}
        label={t('drawing.imageNumber', `图${index + 1}`, { index: index + 1 })}
      />
    ),
  })), [generation.images, t]);
  const contextThumbnails = useMemo(() => [
    ...(generation.source_images ?? []).map((image, index) => ({
      key: `source-${image.id}`,
      storedFileId: image.stored_file_id,
      filePath: image.storage_path,
      label: t('drawing.sourceImageWithIndex', `原图 ${index + 1}`, { index: index + 1 }),
    })),
    ...(generation.mask_file ? [{
      key: `mask-${generation.mask_file.id}`,
      storedFileId: generation.mask_file.id,
      filePath: generation.mask_file.storage_path,
      label: t('drawing.maskImage', 'Mask 图'),
    }] : []),
    ...(generation.reference_files ?? []).map((file, index) => ({
      key: `ref-${file.id}`,
      storedFileId: file.id,
      filePath: file.storage_path,
      label: t('drawing.referenceImageWithIndex', `参考图 ${index + 1}`, { index: index + 1 }),
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
    return loadStoredMediaSource(firstImage.stored_file_id, firstImage.storage_path);
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

  const handleUseAsReference = (image: DrawingImage) => {
    if (!onUseAsReference) return;
    try {
      onUseAsReference(image);
      message.success(t('drawing.referenceAdded', '已加入参考图'));
    } catch (error) {
      message.error(String(error));
    }
  };

  const renderRetryAction = () => (
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
  );

  const renderDirectDeleteAction = () => (
    <Popconfirm
      title={t('drawing.deleteConfirmTitle', '删除这条绘画记录？')}
      okText={t('common.confirm', '确认')}
      cancelText={t('common.cancel', '取消')}
      onConfirm={() => onDelete(generation.id, false)}
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
    </Popconfirm>
  );

  const getImageById = (id: string) => generation.images.find((image) => image.id === id);

  const renderImageAction = ({
    title,
    ariaLabel,
    icon,
    onSelect,
  }: {
    title: string;
    ariaLabel: string;
    icon: ReactNode;
    onSelect: (image: DrawingImage) => void;
  }) => {
    const button = (
      <Tooltip title={title}>
        <Button
          aria-label={ariaLabel}
          size="small"
          color="default"
          variant="filled"
          icon={icon}
          disabled={!firstImage}
          onClick={hasMultipleImages ? undefined : () => firstImage && onSelect(firstImage)}
        />
      </Tooltip>
    );

    if (!hasMultipleImages) return button;

    return (
      <Dropdown
        trigger={['click']}
        menu={{
          items: imageMenuItems,
          onClick: ({ key }) => {
            const image = getImageById(String(key));
            if (image) onSelect(image);
          },
        }}
      >
        {button}
      </Dropdown>
    );
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
                storedFileId={item.storedFileId}
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
              {isStopped && (
                <Tag color="warning" style={{ marginTop: 3 }}>{t('drawing.stopped', '主动停止')}</Tag>
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
            background: isStopped ? token.colorWarningBg : token.colorErrorBg,
            border: `1px solid ${isStopped ? token.colorWarningBorder : token.colorErrorBorder}`,
          }}
        >
          <Typography.Text
            type={isStopped ? 'warning' : 'danger'}
            className="min-w-0 flex-1"
            style={{ whiteSpace: 'pre-wrap' }}
          >
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
          loading={isRunning}
          placeholderCount={placeholderCount}
          onEdit={onEdit}
          onMaskEdit={onMaskEdit}
          onUseAsReference={onUseAsReference ? handleUseAsReference : undefined}
        />
      )}

      {isRunning && onStop && (
        <div className="mt-4 flex gap-2">
          <Popconfirm
            title={t('drawing.stopConfirmTitle', '停止生成？')}
            description={t('drawing.stopConfirmContent', '停止后这条记录会标记为主动停止。')}
            okText={t('common.confirm', '确认')}
            cancelText={t('common.cancel', '取消')}
            onConfirm={() => onStop(generation.id)}
          >
            <Tooltip title={t('common.stop', '停止')}>
              <Button
                aria-label={t('common.stop', '停止')}
                size="small"
                color="default"
                variant="filled"
                icon={<CircleStop size={15} />}
              />
            </Tooltip>
          </Popconfirm>
        </div>
      )}

      {!isRunning && !hasGeneratedImages && (
        <div className="mt-4 flex gap-2">
          {renderRetryAction()}
          {renderDirectDeleteAction()}
        </div>
      )}

      {!isRunning && hasGeneratedImages && (
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
          {onUseAsReference && (
            renderImageAction({
              title: t('drawing.useAsReference', '作为参考图'),
              ariaLabel: t('drawing.useAsReference', '作为参考图'),
              icon: <AtSign size={15} />,
              onSelect: handleUseAsReference,
            })
          )}
          {renderImageAction({
            title: t('drawing.reEdit', '重新编辑'),
            ariaLabel: t('drawing.reEdit', '重新编辑'),
            icon: <Pencil size={15} />,
            onSelect: onEdit,
          })}
          {renderImageAction({
            title: t('drawing.maskEdit', '区域编辑'),
            ariaLabel: t('drawing.maskEdit', '区域编辑'),
            icon: <Focus size={15} />,
            onSelect: onMaskEdit,
          })}
          {renderRetryAction()}
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
