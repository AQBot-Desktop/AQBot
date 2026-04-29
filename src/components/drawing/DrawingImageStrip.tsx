import { Button, Image, Spin, Tooltip, theme } from 'antd';
import { AtSign, Focus, Pencil } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@/lib/invoke';
import type { DrawingImage } from '@/types';

interface Props {
  images: DrawingImage[];
  loading?: boolean;
  placeholderCount?: number;
  onUseAsReference?: (image: DrawingImage) => void;
  onEdit?: (image: DrawingImage) => void;
  onMaskEdit?: (image: DrawingImage) => void;
}

const IMAGE_MAX_WIDTH = 180;
const IMAGE_MAX_HEIGHT = 300;
const IMAGE_CORNER_RADIUS = 6;

const placeholderTileStyle: CSSProperties = {
  flex: `0 0 ${IMAGE_MAX_WIDTH}px`,
  width: IMAGE_MAX_WIDTH,
  height: IMAGE_MAX_HEIGHT,
  borderRadius: IMAGE_CORNER_RADIUS,
};

function getImageTileStyle(image: DrawingImage): CSSProperties {
  const width = image.width && image.width > 0 ? image.width : 1;
  const height = image.height && image.height > 0 ? image.height : 1;
  const ratio = width / height;
  const maxRatio = IMAGE_MAX_WIDTH / IMAGE_MAX_HEIGHT;
  const tileWidth = ratio >= maxRatio
    ? IMAGE_MAX_WIDTH
    : Math.max(1, Math.round(IMAGE_MAX_HEIGHT * ratio));
  const tileHeight = ratio >= maxRatio
    ? Math.max(1, Math.round(IMAGE_MAX_WIDTH / ratio))
    : IMAGE_MAX_HEIGHT;

  return {
    flex: `0 0 ${tileWidth}px`,
    width: tileWidth,
    height: tileHeight,
    borderRadius: IMAGE_CORNER_RADIUS,
    background: 'transparent',
  };
}

function DrawingPreviewImage({
  image,
  onUseAsReference,
  onEdit,
  onMaskEdit,
}: {
  image: DrawingImage;
  onUseAsReference?: (image: DrawingImage) => void;
  onEdit?: (image: DrawingImage) => void;
  onMaskEdit?: (image: DrawingImage) => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const tileStyle = useMemo(() => getImageTileStyle(image), [image.height, image.width]);
  const tileRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const node = tileRef.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: '160px 0px' });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad) return undefined;
    let cancelled = false;
    invoke<string>('read_attachment_preview', { filePath: image.storage_path })
      .then((data) => { if (!cancelled) setSrc(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [image.storage_path, shouldLoad]);

  return (
    <div
      ref={tileRef}
      className="drawing-preview-tile group relative overflow-hidden"
      style={tileStyle}
    >
      {src ? (
        <Image
          src={src}
          width="100%"
          height="100%"
          loading="lazy"
          styles={{
            root: {
              width: '100%',
              height: '100%',
              display: 'block',
              overflow: 'hidden',
              borderRadius: IMAGE_CORNER_RADIUS,
            },
            image: {
              width: '100%',
              height: '100%',
              display: 'block',
              objectFit: 'contain',
              borderRadius: IMAGE_CORNER_RADIUS,
            },
          }}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            objectFit: 'contain',
            borderRadius: IMAGE_CORNER_RADIUS,
          }}
          preview={{ mask: { blur: true }, scaleStep: 0.5 }}
        />
      ) : shouldLoad ? (
        <div className="flex h-full items-center justify-center">
          <Spin size="small" />
        </div>
      ) : (
        <div className="h-full w-full" />
      )}
      {src && (onUseAsReference || onEdit || onMaskEdit) && (
        <div className="drawing-image-hover-actions pointer-events-none absolute right-2 top-2 z-20 flex gap-1">
          {onUseAsReference && (
            <Tooltip title={t('drawing.useAsReference', '作为参考图')}>
              <Button
                aria-label={t('drawing.useAsReference', '作为参考图')}
                className="drawing-image-action-button pointer-events-auto"
                size="small"
                shape="circle"
                color="default"
                variant="filled"
                icon={<AtSign size={15} strokeWidth={2.4} />}
                style={{
                  width: 28,
                  height: 28,
                  boxShadow: token.boxShadowSecondary,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onUseAsReference(image);
                }}
              />
            </Tooltip>
          )}
          {onEdit && (
            <Tooltip title={t('drawing.reEdit', '重新编辑')}>
              <Button
                aria-label={t('drawing.reEdit', '重新编辑')}
                className="drawing-image-action-button pointer-events-auto"
                size="small"
                shape="circle"
                color="default"
                variant="filled"
                icon={<Pencil size={14} />}
                style={{
                  width: 28,
                  height: 28,
                  boxShadow: token.boxShadowSecondary,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(image);
                }}
              />
            </Tooltip>
          )}
          {onMaskEdit && (
            <Tooltip title={t('drawing.maskEdit', '区域编辑')}>
              <Button
                aria-label={t('drawing.maskEdit', '区域编辑')}
                className="drawing-image-action-button pointer-events-auto"
                size="small"
                shape="circle"
                color="default"
                variant="filled"
                icon={<Focus size={14} />}
                style={{
                  width: 28,
                  height: 28,
                  boxShadow: token.boxShadowSecondary,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onMaskEdit(image);
                }}
              />
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

function DrawingImagePlaceholder() {
  const { token } = theme.useToken();

  return (
    <div
      className="drawing-image-placeholder relative overflow-hidden"
      style={{
        ...placeholderTileStyle,
        background: token.colorFillAlter,
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          animation: 'aqbot-drawing-shimmer 1.35s linear infinite',
          background: `linear-gradient(110deg, ${token.colorFillAlter} 8%, ${token.colorFillSecondary} 18%, ${token.colorFillAlter} 33%)`,
          backgroundSize: '220% 100%',
        }}
      />
    </div>
  );
}

export function DrawingImageStrip({
  images,
  loading,
  placeholderCount = 1,
  onUseAsReference,
  onEdit,
  onMaskEdit,
}: Props) {
  const placeholders = useMemo(
    () => Array.from({ length: Math.max(placeholderCount, images.length, 1) }),
    [images.length, placeholderCount],
  );
  if (loading && images.length === 0) {
    return (
      <div className="drawing-image-strip flex w-full overflow-x-auto overflow-y-hidden rounded-md" style={{ gap: 7 }}>
        {placeholders.map((_, index) => (
          <DrawingImagePlaceholder key={index} />
        ))}
      </div>
    );
  }
  return (
    <div className="drawing-image-strip flex w-full overflow-x-auto overflow-y-hidden rounded-md" style={{ gap: 7 }}>
      {images.map((image) => (
        <DrawingPreviewImage
          key={image.id}
          image={image}
          onUseAsReference={onUseAsReference}
          onEdit={onEdit}
          onMaskEdit={onMaskEdit}
        />
      ))}
    </div>
  );
}
