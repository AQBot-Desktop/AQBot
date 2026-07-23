import { Empty, Spin, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { useDrawingStore } from '@/stores/drawingStore';
import type {
  DrawingGeneration,
  DrawingImage,
  DrawingReferenceImageMode,
  ImageOperation,
} from '@/types';
import { DrawingGenerationItem } from './DrawingGenerationItem';

interface Props {
  onEdit: (image: DrawingImage) => void;
  onMaskEdit: (image: DrawingImage) => void;
  onUsePrompt: (prompt: string) => void;
  referenceImageMode: DrawingReferenceImageMode;
  supportedOperations?: ImageOperation[];
}

export function DrawingGenerationList({
  onEdit,
  onMaskEdit,
  onUsePrompt,
  referenceImageMode,
  supportedOperations,
}: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const generations = useDrawingStore((s) => s.generations);
  const loading = useDrawingStore((s) => s.loading);
  const retryGeneration = useDrawingStore((s) => s.retryGeneration);
  const stopGeneration = useDrawingStore((s) => s.stopGeneration);
  const deleteGeneration = useDrawingStore((s) => s.deleteGeneration);
  const useImageAsReference = useDrawingStore((s) => s.useImageAsReference);

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
          onEdit={supportedOperations?.includes('edit') === false ? undefined : onEdit}
          onMaskEdit={supportedOperations?.includes('mask_edit') === false ? undefined : onMaskEdit}
          onRetry={(item) => retryGeneration(item, referenceImageMode).catch(() => {})}
          onStop={stopGeneration}
          onDelete={(id, deleteResources) => deleteGeneration(id, deleteResources).catch(() => {})}
          onUsePrompt={onUsePrompt}
          onUseAsReference={
            supportedOperations?.includes('edit') === false ? undefined : useImageAsReference
          }
        />
      ))}
    </div>
  );
}
