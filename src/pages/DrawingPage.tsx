import { Alert, App, Modal, theme } from 'antd';
import { OverlayScrollbars } from 'overlayscrollbars';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDrawingSettingsStore, useDrawingStore, useProviderStore } from '@/stores';
import type { DrawingImage } from '@/types';
import { DrawingGenerationList } from '@/components/drawing/DrawingGenerationList';
import { DrawingSettingsPanel } from '@/components/drawing/DrawingSettingsPanel';
import { DrawingComposer } from '@/components/drawing/DrawingComposer';
import { DrawingMaskEditor } from '@/components/drawing/DrawingMaskEditor';
import { usePageSuspendCleanup } from '@/components/layout/PageLifecycle';
import { getDrawingModelOptions, getDrawingProvidersForModel } from '@/lib/drawingModels';

const HISTORY_BOTTOM_THRESHOLD = 48;

function getHistoryScrollElement(root: HTMLDivElement | null, forceUpdate = false): HTMLElement | null {
  if (!root) return null;

  try {
    const instance = OverlayScrollbars(root);
    if (instance) {
      if (forceUpdate) instance.update(true);
      const elements = instance.elements();
      return elements.scrollOffsetElement ?? elements.viewport ?? root;
    }
  } catch {
    // Fall back to the DOM node if OverlayScrollbars is unavailable during tests or teardown.
  }

  return root.querySelector<HTMLElement>('[data-overlayscrollbars-viewport]') ?? root;
}

export function DrawingPage() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message, modal } = App.useApp();
  const providers = useProviderStore((s) => s.providers);
  const ensureProvidersLoaded = useProviderStore((s) => s.ensureProvidersLoaded);
  const ensureHistoryLoaded = useDrawingStore((s) => s.ensureHistoryLoaded);
  const error = useDrawingStore((s) => s.error);
  const generations = useDrawingStore((s) => s.generations);
  const selectImageForEdit = useDrawingStore((s) => s.selectImageForEdit);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const historyContentRef = useRef<HTMLDivElement>(null);
  const historyScrollFrameRef = useRef<number | null>(null);
  const followHistoryBottomRef = useRef(false);
  const previousHistoryRef = useRef<{ ids: string[]; latestKey: string } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [maskImage, setMaskImage] = useState<DrawingImage | null>(null);
  const [composerHeight, setComposerHeight] = useState(176);
  const settings = useDrawingSettingsStore((s) => s.settings);
  const setSettings = useDrawingSettingsStore((s) => s.setSettings);
  const latestGeneration = generations[generations.length - 1];
  const latestGenerationScrollKey = latestGeneration
    ? [
      latestGeneration.id,
      latestGeneration.status,
      latestGeneration.images.length,
      latestGeneration.completed_at ?? '',
      latestGeneration.error_message ?? '',
    ].join(':')
    : '';

  usePageSuspendCleanup(() => Modal.destroyAll());

  const drawingModelOptions = useMemo(() => getDrawingModelOptions(), []);

  useEffect(() => {
    void ensureProvidersLoaded();
  }, [ensureProvidersLoaded]);

  useEffect(() => {
    ensureHistoryLoaded().catch((e) => message.error(String(e)));
  }, [ensureHistoryLoaded, message]);

  useEffect(() => {
    return () => setMaskImage(null);
  }, []);

  const scrollHistoryToBottom = useCallback(() => {
    const scroller = getHistoryScrollElement(historyScrollRef.current, true);
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'smooth' });
  }, []);

  const scheduleScrollToBottom = useCallback((passes = 2) => {
    if (historyScrollFrameRef.current !== null) {
      cancelAnimationFrame(historyScrollFrameRef.current);
    }

    const run = (remainingPasses: number) => {
      historyScrollFrameRef.current = requestAnimationFrame(() => {
        historyScrollFrameRef.current = null;
        followHistoryBottomRef.current = true;
        scrollHistoryToBottom();
        if (remainingPasses > 1) run(remainingPasses - 1);
      });
    };

    run(passes);
  }, [scrollHistoryToBottom]);

  const scheduleScrollToBottomAfterDeletion = useCallback((force: boolean) => {
    if (historyScrollFrameRef.current !== null) {
      cancelAnimationFrame(historyScrollFrameRef.current);
    }

    const inspect = (remainingPasses: number) => {
      historyScrollFrameRef.current = requestAnimationFrame(() => {
        historyScrollFrameRef.current = null;
        const scroller = getHistoryScrollElement(historyScrollRef.current, true);
        const isNowNearBottom = scroller
          ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= HISTORY_BOTTOM_THRESHOLD
          : false;

        if (force || isNowNearBottom) {
          scheduleScrollToBottom(Math.max(remainingPasses, 2));
          return;
        }

        if (remainingPasses > 1) inspect(remainingPasses - 1);
      });
    };

    inspect(3);
  }, [scheduleScrollToBottom]);

  const handleHistoryScroll = useCallback(() => {
    const scroller = getHistoryScrollElement(historyScrollRef.current);
    if (!scroller) return;
    const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    followHistoryBottomRef.current = distanceToBottom <= HISTORY_BOTTOM_THRESHOLD;
  }, []);

  useEffect(() => () => {
    if (historyScrollFrameRef.current !== null) {
      cancelAnimationFrame(historyScrollFrameRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const currentHistory = {
      ids: generations.map((generation) => generation.id),
      latestKey: latestGenerationScrollKey,
    };
    const previousHistory = previousHistoryRef.current;
    previousHistoryRef.current = currentHistory;

    if (!currentHistory.latestKey) return;
    if (!previousHistory) {
      scheduleScrollToBottom();
      return;
    }

    const removedIndexes = previousHistory.ids
      .map((id, index) => (currentHistory.ids.includes(id) ? -1 : index))
      .filter((index) => index >= 0);
    const deletedGeneration = removedIndexes.length > 0;
    if (deletedGeneration) {
      const removedLatestGeneration = removedIndexes.some((index) => index === previousHistory.ids.length - 1);
      scheduleScrollToBottomAfterDeletion(removedLatestGeneration || followHistoryBottomRef.current);
      return;
    }

    const addedGeneration = currentHistory.ids.length > previousHistory.ids.length;
    if (addedGeneration || currentHistory.latestKey !== previousHistory.latestKey) {
      scheduleScrollToBottom();
    }
  }, [generations, latestGenerationScrollKey, scheduleScrollToBottom, scheduleScrollToBottomAfterDeletion]);

  useEffect(() => {
    const content = historyContentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver(() => {
      if (followHistoryBottomRef.current) {
        scheduleScrollToBottom();
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scheduleScrollToBottom]);

  useEffect(() => {
    if (followHistoryBottomRef.current) {
      scheduleScrollToBottom();
    }
  }, [composerHeight, scheduleScrollToBottom]);

  useEffect(() => {
    setSettings((current) => {
      const nextModelId = drawingModelOptions.some((model) => model.value === current.modelId)
        ? current.modelId
        : drawingModelOptions[0]?.value ?? current.modelId;
      const nextProviders = getDrawingProvidersForModel(providers, nextModelId);
      const nextProviderId = providers.length === 0
        ? current.providerId
        : nextProviders.some((provider) => provider.id === current.providerId)
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
  }, [drawingModelOptions, providers, setSettings]);

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
          className="absolute left-0 right-0 top-0"
          data-testid="drawing-history-frame"
          style={{ bottom: composerHeight }}
        >
          <div
            ref={historyScrollRef}
            className="h-full overflow-y-auto"
            data-testid="drawing-history-scroll"
            onScroll={handleHistoryScroll}
            onScrollCapture={handleHistoryScroll}
          >
            <div ref={historyContentRef} className={generations.length === 0 ? 'min-h-full' : undefined}>
              {error && (
                <div style={{ padding: '12px 24px 0' }}>
                  <Alert type="error" showIcon message={error} />
                </div>
              )}
              <DrawingGenerationList
                onEdit={(image) => selectImageForEdit(image)}
                onMaskEdit={handleMaskEdit}
                onUsePrompt={handleUsePrompt}
                referenceImageMode={settings.referenceImageMode}
              />
            </div>
          </div>
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
