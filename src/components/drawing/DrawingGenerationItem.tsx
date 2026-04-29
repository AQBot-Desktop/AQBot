import { Button, Dropdown, Tag, Typography, theme } from 'antd';
import { MoreHorizontal, Pencil, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DrawingGeneration, DrawingImage } from '@/types';
import { describeDrawingSize } from '@/lib/drawingModels';
import { DrawingImageStrip } from './DrawingImageStrip';

interface Props {
  generation: DrawingGeneration;
  onEdit: (image: DrawingImage) => void;
  onMaskEdit: (image: DrawingImage) => void;
  onRetry: (generation: DrawingGeneration) => void;
  onDelete: (id: string) => void;
}

function parseParams(generation: DrawingGeneration): Record<string, any> {
  try {
    return JSON.parse(generation.parameters_json || '{}');
  } catch {
    return {};
  }
}

export function DrawingGenerationItem({ generation, onEdit, onMaskEdit, onRetry, onDelete }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const params = parseParams(generation);
  const meta = [
    `图片 ${generation.images.length || params.n || 1}`,
    describeDrawingSize(params.size || '1024x1024'),
    generation.model_id,
    `${params.n || generation.images.length || 1}张`,
  ].join(' | ');
  const firstImage = generation.images[0];

  return (
    <section
      style={{
        padding: '20px 24px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
      }}
    >
      <div className="mb-3">
        <Typography.Text style={{ fontSize: 16, lineHeight: 1.7 }}>
          {generation.prompt}
        </Typography.Text>
        <Typography.Text style={{ color: token.colorTextSecondary, marginLeft: 12 }}>
          {meta}
        </Typography.Text>
        {generation.status === 'failed' && (
          <Tag color="error" style={{ marginLeft: 8 }}>{t('drawing.failed', '失败')}</Tag>
        )}
        {generation.status === 'running' && (
          <Tag color="processing" style={{ marginLeft: 8 }}>{t('drawing.generating', '生成中')}</Tag>
        )}
      </div>

      {generation.error_message ? (
        <Typography.Text type="danger">{generation.error_message}</Typography.Text>
      ) : (
        <DrawingImageStrip
          images={generation.images}
          loading={generation.status === 'running'}
          onEdit={onEdit}
          onMaskEdit={onMaskEdit}
        />
      )}

      <div className="mt-4 flex gap-2">
        <Button
          icon={<Pencil size={16} />}
          disabled={!firstImage}
          onClick={() => firstImage && onEdit(firstImage)}
        >
          {t('drawing.reEdit', '重新编辑')}
        </Button>
        <Button icon={<RefreshCw size={16} />} onClick={() => onRetry(generation)}>
          {t('drawing.regenerate', '再次生成')}
        </Button>
        <Dropdown
          menu={{
            items: [
              {
                key: 'delete',
                label: t('drawing.deleteRecord', '删除记录'),
                danger: true,
              },
            ],
            onClick: ({ key }) => {
              if (key === 'delete') onDelete(generation.id);
            },
          }}
        >
          <Button icon={<MoreHorizontal size={16} />} />
        </Dropdown>
      </div>
    </section>
  );
}
