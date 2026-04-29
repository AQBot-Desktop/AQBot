import { Button, Image, Spin, Tooltip, theme } from 'antd';
import { Download, Focus, Pencil } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import type { DrawingImage } from '@/types';
import { saveChatImage } from '@/lib/chatImageActions';

interface Props {
  images: DrawingImage[];
  loading?: boolean;
  onEdit: (image: DrawingImage) => void;
  onMaskEdit: (image: DrawingImage) => void;
}

function DrawingPreviewImage({
  image,
  onEdit,
  onMaskEdit,
}: {
  image: DrawingImage;
  onEdit: (image: DrawingImage) => void;
  onMaskEdit: (image: DrawingImage) => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string>('read_attachment_preview', { filePath: image.storage_path })
      .then((data) => { if (!cancelled) setSrc(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [image.storage_path]);

  const actions = (
    <div
      className="absolute inset-0 opacity-0 transition-opacity hover:opacity-100"
      style={{ background: 'rgba(17,24,39,0.2)' }}
    >
      <div className="absolute right-2 top-2 flex gap-1">
        <Tooltip title={t('drawing.download', '下载')}>
          <Button
            size="small"
            shape="circle"
            icon={<Download size={14} />}
            onClick={() => src && saveChatImage(src, image.storage_path.split('/').pop() || 'drawing.png').catch(() => {})}
          />
        </Tooltip>
        <Tooltip title={t('drawing.edit', '重新编辑')}>
          <Button size="small" shape="circle" icon={<Pencil size={14} />} onClick={() => onEdit(image)} />
        </Tooltip>
        <Tooltip title={t('drawing.maskEdit', '区域编辑')}>
          <Button size="small" shape="circle" icon={<Focus size={14} />} onClick={() => onMaskEdit(image)} />
        </Tooltip>
      </div>
    </div>
  );

  return (
    <div
      className="relative overflow-hidden"
      style={{
        minWidth: 220,
        flex: '1 1 0',
        aspectRatio: '16 / 9',
        background: token.colorFillAlter,
      }}
    >
      {src ? (
        <Image
          src={src}
          width="100%"
          height="100%"
          style={{ objectFit: 'cover' }}
          preview={{ mask: { blur: true }, scaleStep: 0.5 }}
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Spin size="small" />
        </div>
      )}
      {actions}
    </div>
  );
}

export function DrawingImageStrip({ images, loading, onEdit, onMaskEdit }: Props) {
  const { token } = theme.useToken();
  const placeholders = useMemo(() => Array.from({ length: Math.max(images.length, 1) }), [images.length]);
  if (loading && images.length === 0) {
    return (
      <div className="flex gap-px overflow-hidden rounded-md">
        {placeholders.map((_, index) => (
          <div
            key={index}
            className="flex h-48 flex-1 items-center justify-center"
            style={{ background: token.colorFillAlter }}
          >
            <Spin />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex gap-px overflow-x-auto overflow-y-hidden rounded-md">
      {images.map((image) => (
        <DrawingPreviewImage
          key={image.id}
          image={image}
          onEdit={onEdit}
          onMaskEdit={onMaskEdit}
        />
      ))}
    </div>
  );
}
