import { Empty, Spin, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { useDrawingStore } from '@/stores/drawingStore';
import type { DrawingGeneration, DrawingImage } from '@/types';
import { DrawingGenerationItem } from './DrawingGenerationItem';

interface Props {
  onEdit: (image: DrawingImage) => void;
  onMaskEdit: (image: DrawingImage) => void;
  onUsePrompt: (prompt: string) => void;
}

export function DrawingGenerationList({ onEdit, onMaskEdit, onUsePrompt }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const generations = useDrawingStore((s) => s.generations);
  const loading = useDrawingStore((s) => s.loading);
  const retryGeneration = useDrawingStore((s) => s.retryGeneration);
  const deleteGeneration = useDrawingStore((s) => s.deleteGeneration);

  if (loading && generations.length === 0) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="drawing-generation-list">
        <Spin />
      </div>
    );
  }

  if (generations.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="drawing-generation-list"
        style={{ color: token.colorTextSecondary }}
      >
        <Empty description={t('drawing.empty', '暂无绘画记录')} />
      </div>
    );
  }

  return (
    <div data-testid="drawing-generation-list">
      {generations.map((generation: DrawingGeneration) => (
        <DrawingGenerationItem
          key={generation.id}
          generation={generation}
          onEdit={onEdit}
          onMaskEdit={onMaskEdit}
          onRetry={(item) => retryGeneration(item).catch(() => {})}
          onDelete={(id, deleteResources) => deleteGeneration(id, deleteResources).catch(() => {})}
          onUsePrompt={onUsePrompt}
        />
      ))}
    </div>
  );
}
