import { Alert, App, theme, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
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
  const { message } = App.useApp();
  const providers = useProviderStore((s) => s.providers);
  const fetchProviders = useProviderStore((s) => s.fetchProviders);
  const loadHistory = useDrawingStore((s) => s.loadHistory);
  const error = useDrawingStore((s) => s.error);
  const selectImageForEdit = useDrawingStore((s) => s.selectImageForEdit);
  const [prompt, setPrompt] = useState('');
  const [maskImage, setMaskImage] = useState<DrawingImage | null>(null);

  const drawingModelOptions = useMemo(() => getDrawingModelOptions(), []);

  const [settings, setSettings] = useState<DrawingSettings>({
    providerId: '',
    modelId: 'gpt-image-2',
    size: '1024x1024',
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
    selectImageForEdit(image);
  };

  return (
    <div className="flex h-full" style={{ background: token.colorBgLayout }}>
      <DrawingSettingsPanel settings={settings} providers={providers} onChange={setSettings} />
      <main className="relative min-w-0 flex-1 overflow-hidden">
        <div
          className="flex items-center justify-between"
          style={{
            height: 56,
            padding: '0 24px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('drawing.title', '绘画')}
          </Typography.Title>
          <Typography.Text style={{ color: token.colorTextSecondary, fontSize: 12 }}>
            {t('drawing.history', '历史记录')}
          </Typography.Text>
        </div>
        {error && (
          <div style={{ padding: '12px 24px 0' }}>
            <Alert type="error" showIcon message={error} />
          </div>
        )}
        <div className="h-[calc(100%-56px)] overflow-y-auto pb-44">
          <DrawingGenerationList
            onEdit={(image) => selectImageForEdit(image)}
            onMaskEdit={handleMaskEdit}
          />
        </div>
        <DrawingComposer settings={settings} prompt={prompt} onPromptChange={setPrompt} />
      </main>
      <DrawingMaskEditor
        open={!!maskImage}
        image={maskImage}
        prompt={prompt}
        settings={settings}
        onClose={() => setMaskImage(null)}
      />
    </div>
  );
}
