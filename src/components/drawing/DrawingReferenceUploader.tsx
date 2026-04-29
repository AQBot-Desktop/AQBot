import { App, Button, Image, Upload, theme } from 'antd';
import { ImagePlus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDrawingStore } from '@/stores/drawingStore';
import { invoke } from '@/lib/invoke';
import { useEffect, useState } from 'react';

function ReferenceThumb({ storagePath }: { storagePath: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<string>('read_attachment_preview', { filePath: storagePath })
      .then((data) => { if (!cancelled) setSrc(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [storagePath]);
  if (!src) return <div style={{ width: 48, height: 48 }} />;
  return (
    <Image
      src={src}
      width={48}
      height={48}
      style={{ objectFit: 'cover', borderRadius: 6 }}
      preview={{ mask: { blur: true }, scaleStep: 0.5 }}
    />
  );
}

export function DrawingReferenceUploader() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const references = useDrawingStore((s) => s.references);
  const uploadReferenceImage = useDrawingStore((s) => s.uploadReferenceImage);
  const removeReference = useDrawingStore((s) => s.removeReference);

  return (
    <div>
      <Upload.Dragger
        multiple
        showUploadList={false}
        accept="image/png,image/jpeg,image/jpg,image/webp"
        beforeUpload={(file) => {
          uploadReferenceImage(file)
            .catch((e) => message.error(String(e)));
          return false;
        }}
        style={{
          background: token.colorFillAlter,
          borderColor: token.colorBorderSecondary,
          borderRadius: 8,
        }}
      >
        <div className="flex flex-col items-center gap-1 py-2">
          <ImagePlus size={18} style={{ color: token.colorPrimary }} />
          <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
            {t('drawing.referenceUpload', '上传参考图')}
          </span>
        </div>
      </Upload.Dragger>

      {references.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {references.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2"
              style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8, padding: 6 }}
            >
              <ReferenceThumb storagePath={item.storage_path} />
              <div className="min-w-0 flex-1">
                <div className="truncate" style={{ fontSize: 12 }}>{item.original_name}</div>
                <div style={{ fontSize: 11, color: token.colorTextSecondary }}>
                  {Math.round(item.size_bytes / 1024)} KB
                </div>
              </div>
              <Button
                type="text"
                size="small"
                icon={<Trash2 size={14} />}
                onClick={() => removeReference(item.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
