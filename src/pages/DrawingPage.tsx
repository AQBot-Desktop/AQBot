import { Alert, App, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDrawingStore, useProviderStore } from '@/stores';
import type { DrawingImage } from '@/types';
import { DrawingGenerationList } from '@/components/drawing/DrawingGenerationList';
import { DrawingSettingsPanel, type DrawingSettings } from '@/components/drawing/DrawingSettingsPanel';
import { DrawingComposer } from '@/components/drawing/DrawingComposer';
import { DrawingMaskEditor } from '@/components/drawing/DrawingMaskEditor';
import { getDrawingModelOptions, getDrawingProvidersForModel } from '@/lib/drawingModels';

export function DrawingPage() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message, modal } = App.useApp();
  const providers = useProviderStore((s) => s.providers);
  const fetchProviders = useProviderStore((s) => s.fetchProviders);
  const loadHistory = useDrawingStore((s) => s.loadHistory);
  const error = useDrawingStore((s) => s.error);
  const generations = useDrawingStore((s) => s.generations);
  const selectImageForEdit = useDrawingStore((s) => s.selectImageForEdit);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState('');
  const [maskImage, setMaskImage] = useState<DrawingImage | null>(null);
  const [composerHeight, setComposerHeight] = useState(176);
  const latestGenerationId = generations[generations.length - 1]?.id;

  const drawingModelOptions = useMemo(() => getDrawingModelOptions(), []);

  const [settings, setSettings] = useState<DrawingSettings>({
    providerId: '',
    modelId: 'gpt-image-2',
    size: 'auto',
    quality: 'auto',
    outputFormat: 'png',
    background: 'auto',
    outputCompression: undefined,
    n: 1,
  });

  useEffect(() => {
    if (providers.length === 0) fetchProviders();
  }, [fetchProviders, providers.length]);

  useEffect(() => {
    loadHistory().catch((e) => message.error(String(e)));
  }, [loadHistory, message]);

  useEffect(() => {
    if (!latestGenerationId) return undefined;
    const frameId = requestAnimationFrame(() => {
      const scroller = historyScrollRef.current;
      if (!scroller) return;
      scroller.scrollTop = scroller.scrollHeight;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frameId);
  }, [latestGenerationId]);

  useEffect(() => {
    setSettings((current) => {
      const nextModelId = drawingModelOptions.some((model) => model.value === current.modelId)
        ? current.modelId
        : drawingModelOptions[0]?.value ?? current.modelId;
      const nextProviders = getDrawingProvidersForModel(providers, nextModelId);
      const nextProviderId = nextProviders.some((provider) => provider.id === current.providerId)
        ? current.providerId
        : nextProviders[0]?.id ?? '';

      if (nextModelId === current.modelId && nextProviderId === current.providerId) {
        return current;
      }

      return {
        ...current,
        modelId: nextModelId,
        providerId: nextProviderId,
      };
    });
  }, [drawingModelOptions, providers]);

  const handleMaskEdit = (image: DrawingImage) => {
    setMaskImage(image);
  };

  const handleUsePrompt = useCallback((nextPrompt: string) => {
    if (!prompt.trim() || prompt === nextPrompt) {
      setPrompt(nextPrompt);
      return;
    }

    modal.confirm({
      title: t('drawing.replacePromptTitle', '替换当前提示词？'),
      content: t('drawing.replacePromptContent', '输入框已有内容，是否使用这条历史提示词替换当前内容？'),
      okText: t('common.confirm', '确认'),
      cancelText: t('common.cancel', '取消'),
      onOk: () => setPrompt(nextPrompt),
    });
  }, [modal, prompt, t]);

  return (
    <div className="flex h-full" style={{ background: token.colorBgLayout }}>
      <DrawingSettingsPanel settings={settings} providers={providers} onChange={setSettings} />
      <main className="relative min-w-0 flex-1 overflow-hidden" style={{ background: token.colorBgContainer }}>
        <div
          ref={historyScrollRef}
          className="h-full overflow-y-auto"
          data-testid="drawing-history-scroll"
          style={{ paddingBottom: composerHeight + 16 }}
        >
          {error && (
            <div style={{ padding: '12px 24px 0' }}>
              <Alert type="error" showIcon message={error} />
            </div>
          )}
          <DrawingGenerationList
            onEdit={(image) => selectImageForEdit(image)}
            onMaskEdit={handleMaskEdit}
            onUsePrompt={handleUsePrompt}
          />
        </div>
        <DrawingComposer
          settings={settings}
          prompt={prompt}
          onPromptChange={setPrompt}
          onHeightChange={setComposerHeight}
        />
      </main>
      <DrawingMaskEditor
        open={!!maskImage}
        image={maskImage}
        onApply={(image, maskFile, previewUrl) => {
          selectImageForEdit(image, maskFile, previewUrl);
          setMaskImage(null);
        }}
        onClose={() => setMaskImage(null)}
      />
    </div>
  );
}
