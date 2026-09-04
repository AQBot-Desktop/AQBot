import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, ConfigProvider, Image, Input, Select, Spin, theme as antdTheme } from 'antd';
import {
  ArrowLeftRight,
  Check,
  Copy,
  Pin,
  PinOff,
  RotateCcw,
  SendHorizontal,
  Square,
  X,
} from 'lucide-react';
import NodeRenderer, { enableD2, setCustomComponents } from 'markstream-react';
import { registerHighlight } from 'stream-markdown';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import i18n from '@/i18n';
import type {
  SelectionToolbarHistoryItem,
  SelectionToolbarRunView,
  SelectionToolbarToolView,
  SelectionToolbarCaptureError,
} from '@/types';
import { invoke } from '@/lib/invoke';
import { useSelectionToolbarStore } from '@/stores/selectionToolbarStore';
import { useSettingsStore } from '@/stores';
import { quoteCssFontFamily } from '@/lib/cssFontFamily';
import {
  SelectionToolbarStrip,
  selectionToolbarOverflowSurfaceHeight,
  type SelectionToolbarStripItem,
} from '@/components/shared/SelectionToolbarStrip';
import {
  SELECTION_TRANSLATE_LANGUAGES,
  normalizeTranslateLanguage,
} from '@/constants/selectionTranslateLanguages';
import { CHAT_CUSTOM_HTML_TAGS } from '@/lib/chatMarkdown';
import { applyMarkstreamI18nMap } from '@/lib/markstreamI18n';
import { preloadChatRenderers } from '@/lib/preloadChatRenderers';
import {
  CHAT_INFOGRAPHIC_PROPS,
  CHAT_MERMAID_PROPS,
  CHAT_RENDER_BATCH_PROPS,
  ThinkNode,
  getChatCodeBlockProps,
  getChatCodeThemes,
} from '@/components/chat/chatMarkdownShared';
import { closeStreamingThinkBlock } from '@/components/chat/chatStreaming';
import './selectionToolbar.css';

// Same registration shape as the chat window so <think> reasoning blocks
// render with the identical collapsible component.
setCustomComponents('selection-toolbar', { think: ThinkNode });

function labelFor(tool: SelectionToolbarToolView, t: (key: string) => string) {
  if (tool.name) return tool.name;
  return t(`settings.selectionToolbar.tools.${tool.builtin_key}`);
}

function executionErrorMessage(error: string, t: TFunction): string {
  const code = error.replace(/^Error: /, '');
  if (code === 'selection_toolbar_source_text_required') return t('settings.selectionToolbar.sourceTextRequired');
  if (code === 'selection_toolbar_vision_required') return t('settings.selectionToolbar.visionRequired');
  return error;
}

function captureErrorMessage(error: SelectionToolbarCaptureError, t: TFunction): string {
  const keys: Record<string, string> = {
    capture_permission_required: 'settings.selectionToolbar.capturePermissionRequired',
    capture_unavailable: 'settings.selectionToolbar.captureUnavailable',
    capture_busy: 'settings.selectionToolbar.captureBusy',
    capture_invalid_region: 'settings.selectionToolbar.captureInvalidRegion',
    capture_expired: 'settings.selectionToolbar.captureExpired',
    capture_too_large: 'settings.selectionToolbar.captureTooLarge',
  };
  const key = keys[error.code];
  return key ? t(key) : t('settings.selectionToolbar.captureFailed', { error: error.detail });
}

function CaptureErrorBanner() {
  const { t } = useTranslation();
  const error = useSelectionToolbarStore((state) => state.captureError);
  const session = useSelectionToolbarStore((state) => state.session);
  const clear = useSelectionToolbarStore((state) => state.clearCaptureError);
  const close = useSelectionToolbarStore((state) => state.close);
  if (!error) return null;
  return (
    <div className="selection-toolbar__capture-error" role="alert">
      <span>{captureErrorMessage(error, t)}</span>
      <Button
        aria-label={t('common.close')}
        icon={<X size={14} />}
        size="small"
        type="text"
        onClick={() => void (session ? clear() : close('capture_error'))}
      />
    </div>
  );
}

function ScreenshotPreview({ selectionId }: { selectionId: string }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ selectionId: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    void invoke<ArrayBuffer>('selection_toolbar_read_image', { selectionId }).then((bytes) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      setPreview({ selectionId, url: objectUrl });
    }).catch((error) => {
      if (!disposed) setPreview({ selectionId, error: String(error) });
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [selectionId]);
  const current = preview?.selectionId === selectionId ? preview : null;
  if (current?.error) return (
    <div className="selection-toolbar__error" role="alert">
      {t('settings.selectionToolbar.captureFailed', { error: current.error })}
    </div>
  );
  if (!current?.url) return <Spin size="small" />;
  return (
    <Image
      alt={t('settings.selectionToolbar.screenshotPreview')}
      className="selection-toolbar__screenshot"
      preview={{ mask: { blur: true }, scaleStep: 0.5 }}
      src={current.url}
    />
  );
}

function beginWindowDrag(onDragEnded: () => Promise<void>) {
  const root = document.documentElement;
  root.dataset.dragging = 'true';
  const clear = () => {
    delete root.dataset.dragging;
    window.removeEventListener('pointerup', clear);
    window.removeEventListener('mouseup', clear);
    window.removeEventListener('mouseenter', clear);
    window.removeEventListener('blur', clear);
  };
  // The native drag swallows pointer events, so clear on whichever event the
  // webview receives first after the drag session ends.
  window.addEventListener('pointerup', clear);
  window.addEventListener('mouseup', clear);
  window.addEventListener('mouseenter', clear);
  window.addEventListener('blur', clear);
  void import('@tauri-apps/api/webviewWindow')
    .then(async ({ getCurrentWebviewWindow }) => {
      try {
        await getCurrentWebviewWindow().startDragging();
      } finally {
        await onDragEnded();
      }
    })
    .catch((error) => {
      console.error('Selection toolbar window drag failed:', error);
    })
    .finally(clear);
}

function toolbarItems(
  tools: SelectionToolbarToolView[],
  activeToolId: string | undefined,
  t: (key: string) => string,
): SelectionToolbarStripItem[] {
  return tools.map((tool) => ({
    id: tool.id,
    icon: tool.icon,
    label: labelFor(tool, t),
    active: activeToolId === tool.id,
  }));
}

function ToolbarSurface({
  expanded,
  dropdownDirection = 'below',
  onVisibleCountChange,
}: {
  expanded?: boolean;
  dropdownDirection?: 'above' | 'below';
  onVisibleCountChange?: (count: number) => void;
}) {
  const { t } = useTranslation();
  const session = useSelectionToolbarStore((state) => state.session);
  const copied = useSelectionToolbarStore((state) => state.copied);
  const busy = useSelectionToolbarStore((state) => state.busy);
  const activeToolId = useSelectionToolbarStore((state) => state.pendingRequest?.tool_id ?? state.run?.tool_id);
  const executeTool = useSelectionToolbarStore((state) => state.executeTool);
  const dragEnded = useSelectionToolbarStore((state) => state.dragEnded);
  const toggleOverflow = useSelectionToolbarStore((state) => state.toggleOverflow);
  if (!session) return null;
  return (
    <SelectionToolbarStrip
      busy={busy}
      copied={copied}
      copiedLabel={t('common.copied')}
      displayMode={session.display_mode ?? 'full'}
      dragLabel={t('settings.selectionToolbar.drag')}
      dropdownDirection={dropdownDirection}
      expanded={expanded}
      items={toolbarItems(session.tools, activeToolId, t)}
      moreLabel={t('settings.selectionToolbar.more')}
      onVisibleCountChange={onVisibleCountChange}
      onDragPointerDown={() => beginWindowDrag(dragEnded)}
      onMorePointerDown={(overflowCount) => void toggleOverflow(
        selectionToolbarOverflowSurfaceHeight(overflowCount),
      )}
      onToolPointerDown={(id) => {
        const tool = session.tools.find((item) => item.id === id);
        if (tool) void executeTool(tool);
      }}
    />
  );
}

function ToolbarSurfaceHost({ expanded }: { expanded: boolean }) {
  const session = useSelectionToolbarStore((state) => state.session);
  const toggleOverflow = useSelectionToolbarStore((state) => state.toggleOverflow);
  const overflowDirection = useSelectionToolbarStore((state) => state.overflowDirection);
  if (!session) return null;
  return (
    <div
      className={`selection-toolbar__surface${expanded ? ' selection-toolbar__overflow' : ''}`}
      data-direction={overflowDirection}
    >
      <ToolbarSurface
        dropdownDirection={overflowDirection}
        expanded={expanded}
        onVisibleCountChange={expanded
          ? (count) => {
              if (count >= session.tools.length) void toggleOverflow();
            }
          : undefined}
      />
    </div>
  );
}

function ResultMarkdown({ output, streaming, isDark }: {
  output: string;
  streaming: boolean;
  isDark: boolean;
}) {
  const codeTheme = useSettingsStore((state) => state.settings.code_theme);
  const codeThemeLight = useSettingsStore((state) => state.settings.code_theme_light);
  const codeFontFamily = useSettingsStore((state) => state.settings.code_font_family);
  const { darkTheme, lightTheme, themes } = useMemo(
    () => getChatCodeThemes(codeTheme, codeThemeLight),
    [codeTheme, codeThemeLight],
  );
  const codeBlockProps = useMemo(
    () => getChatCodeBlockProps(darkTheme, lightTheme),
    [darkTheme, lightTheme],
  );
  const codeBlockMonacoOptions = useMemo(
    () => codeFontFamily ? { fontFamily: quoteCssFontFamily(codeFontFamily) } : undefined,
    [codeFontFamily],
  );
  useEffect(() => {
    registerHighlight({ themes: themes as never }).catch((error) => {
      console.error('Selection toolbar registerHighlight failed:', error);
    });
  }, [themes]);
  // Close a dangling <think> block while streaming so the parser produces a
  // complete think node (same trick as the chat streaming path).
  const content = closeStreamingThinkBlock(output, streaming);
  return (
    <div className="aqbot-chat-markdown">
      <NodeRenderer
        key={`${isDark ? 'dark' : 'light'}:${darkTheme}:${lightTheme}`}
        content={content}
        customId="selection-toolbar"
        customHtmlTags={CHAT_CUSTOM_HTML_TAGS}
        final={!streaming}
        isDark={isDark}
        typewriter={false}
        themes={themes}
        codeBlockLightTheme={lightTheme}
        codeBlockDarkTheme={darkTheme}
        codeBlockProps={codeBlockProps}
        codeBlockMonacoOptions={codeBlockMonacoOptions}
        mermaidProps={CHAT_MERMAID_PROPS}
        infographicProps={CHAT_INFOGRAPHIC_PROPS}
        {...CHAT_RENDER_BATCH_PROPS}
      />
    </div>
  );
}

interface TranslateLanguageOption {
  value: string;
  label: string;
  english: string;
}

function filterTranslateOption(input: string, option?: TranslateLanguageOption): boolean {
  const query = input.trim().toLowerCase();
  if (!query || !option) return true;
  return (
    option.value.toLowerCase().includes(query)
    || option.label.toLowerCase().includes(query)
    || option.english.toLowerCase().includes(query)
  );
}

/// Google-Translate-style language row for the builtin translate tool:
/// source (auto-detect by default) ⇄ target; changing either re-runs the
/// translation and the target choice is persisted for future sessions.
function TranslateBar() {
  const { t } = useTranslation();
  const session = useSelectionToolbarStore((state) => state.session);
  const translateSource = useSelectionToolbarStore((state) => state.translateSource);
  const translateTarget = useSelectionToolbarStore((state) => state.translateTarget);
  const setTranslateLanguages = useSelectionToolbarStore((state) => state.setTranslateLanguages);
  const busy = useSelectionToolbarStore((state) => state.busy);
  const target = translateTarget
    ?? normalizeTranslateLanguage(session?.translate_target_language ?? session?.language);
  const targetOptions = useMemo<TranslateLanguageOption[]>(
    () => SELECTION_TRANSLATE_LANGUAGES.map((language) => ({
      value: language.code,
      label: language.native,
      english: language.english,
    })),
    [],
  );
  const sourceOptions = useMemo<TranslateLanguageOption[]>(
    () => [
      {
        value: 'auto',
        label: t('settings.selectionToolbar.translateAutoDetect'),
        english: 'auto detect',
      },
      ...targetOptions,
    ],
    [t, targetOptions],
  );

  return (
    <div className="selection-toolbar__translate-bar">
      <Select<string, TranslateLanguageOption>
        aria-label={t('settings.selectionToolbar.translateSourceLanguage')}
        disabled={busy}
        filterOption={filterTranslateOption}
        listHeight={190}
        options={sourceOptions}
        popupMatchSelectWidth={false}
        showSearch
        size="small"
        style={{ flex: 1, minWidth: 0 }}
        value={translateSource}
        variant="borderless"
        onChange={(source) => void setTranslateLanguages(source, target)}
      />
      <Button
        aria-label={t('settings.selectionToolbar.translateSwap')}
        disabled={translateSource === 'auto' || busy}
        icon={<ArrowLeftRight size={13} />}
        size="small"
        title={t('settings.selectionToolbar.translateSwap')}
        type="text"
        onClick={() => {
          if (translateSource === 'auto') return;
          void setTranslateLanguages(target, translateSource);
        }}
      />
      <Select<string, TranslateLanguageOption>
        aria-label={t('settings.selectionToolbar.translateTargetLanguage')}
        disabled={busy}
        filterOption={filterTranslateOption}
        listHeight={190}
        options={targetOptions}
        popupMatchSelectWidth={false}
        showSearch
        size="small"
        style={{ flex: 1, minWidth: 0 }}
        value={target}
        variant="borderless"
        onChange={(next) => void setTranslateLanguages(translateSource, next)}
      />
    </div>
  );
}

/// Chat-style stickiness: follow the stream to the bottom until the user
/// scrolls away from it; scrolling back to the bottom re-engages following.
const AUTO_SCROLL_BOTTOM_THRESHOLD = 24;

type ResultTurn = SelectionToolbarHistoryItem | SelectionToolbarRunView;

function ResultTurnContent({
  isCurrent,
  isDark,
  turn,
}: {
  isCurrent: boolean;
  isDark: boolean;
  turn: ResultTurn;
}) {
  const { t } = useTranslation();
  const streaming = isCurrent && (turn.status === 'started' || turn.status === 'streaming');
  return (
    <article className="selection-toolbar__turn">
      {turn.user_input && (
        <div className="selection-toolbar__user-turn">{turn.user_input}</div>
      )}
      <div className="selection-toolbar__assistant-turn">
        {turn.output && (
          <ResultMarkdown
            isDark={isDark}
            output={turn.output}
            streaming={streaming}
          />
        )}
        {!turn.output && !turn.error && streaming && (
          <div className="selection-toolbar__waiting">{t('chat.thinkingInProgress')}</div>
        )}
        {turn.error && <div className="selection-toolbar__error">{executionErrorMessage(turn.error, t)}</div>}
      </div>
    </article>
  );
}

function ResultSurface() {
  const { t } = useTranslation();
  const session = useSelectionToolbarStore((state) => state.session);
  const history = useSelectionToolbarStore((state) => state.history);
  const run = useSelectionToolbarStore((state) => state.run);
  const pending = useSelectionToolbarStore((state) => state.pendingRequest);
  const updatePending = useSelectionToolbarStore((state) => state.updatePendingRequest);
  const submitInitial = useSelectionToolbarStore((state) => state.submitInitial);
  const copied = useSelectionToolbarStore((state) => state.copied);
  const busy = useSelectionToolbarStore((state) => state.busy);
  const error = useSelectionToolbarStore((state) => state.error);
  const followUp = useSelectionToolbarStore((state) => state.followUp);
  const stop = useSelectionToolbarStore((state) => state.stop);
  const copyResult = useSelectionToolbarStore((state) => state.copyResult);
  const regenerate = useSelectionToolbarStore((state) => state.regenerate);
  const setPinned = useSelectionToolbarStore((state) => state.setPinned);
  const dragEnded = useSelectionToolbarStore((state) => state.dragEnded);
  const close = useSelectionToolbarStore((state) => state.close);
  const [draft, setDraft] = useState('');
  const contentRef = useRef<HTMLElement | null>(null);
  const composingRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const requestId = run?.request_id;

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [requestId]);

  useEffect(() => {
    const element = contentRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [history.length, requestId, run?.output]);

  if (!run && !pending) return null;
  const streaming = !pending && (run?.status === 'started' || run?.status === 'streaming');
  const followUpAvailable = (run?.status === 'completed' || run?.status === 'stopped')
    && run.output.trim().length > 0;
  const sendDisabled = busy || (pending
    ? !pending.input || (pending.input.kind === 'text' && !pending.input.text.trim())
    : !followUpAvailable || draft.trim().length === 0);
  const tool = session?.tools.find((candidate) => candidate.id === (pending?.tool_id ?? run?.tool_id));
  const title = tool
    ? t('settings.selectionToolbar.aiFeatureTitle', { feature: labelFor(tool, t) })
    : t('settings.selectionToolbar.result');
  const pinLabel = t(
    session?.pinned
      ? 'settings.selectionToolbar.unpinResult'
      : 'settings.selectionToolbar.pinResult',
  );
  const submitFollowUp = () => {
    if (sendDisabled) return;
    if (pending) {
      void submitInitial();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    void followUp(text).then((sent) => {
      if (!sent) return;
      setDraft((current) => current.trim() === text ? '' : current);
    });
  };

  return (
    <div
      className="selection-toolbar__result-stack"
      data-placement={session?.resolved_placement ?? 'below'}
    >
      <ToolbarSurface />
      <section className="selection-toolbar__result">
        <header className="selection-toolbar__result-header">
          <div
            className="selection-toolbar__result-title"
            title={t('settings.selectionToolbar.drag')}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              beginWindowDrag(dragEnded);
            }}
          >
            {streaming && <Spin size="small" />}
            <span>{title}</span>
          </div>
          <div className="selection-toolbar__result-actions">
            <Button
              aria-label={pinLabel}
              aria-pressed={session?.pinned ?? false}
              icon={session?.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              size="small"
              title={pinLabel}
              type="text"
              onClick={() => void setPinned(!(session?.pinned ?? false))}
            />
            {!pending && run?.output && (
              <Button
                aria-label={t('common.copy')}
                icon={copied ? <Check size={14} /> : <Copy size={14} />}
                size="small"
                type="text"
                onClick={() => void copyResult()}
              />
            )}
            {!pending && <Button
              aria-label={t('chat.regenerate')}
              disabled={streaming || busy}
              icon={<RotateCcw size={14} />}
              size="small"
              title={t('chat.regenerate')}
              type="text"
              onClick={() => void regenerate()}
            />}
            {streaming && (
              <Button
                aria-label={t('chat.stop')}
                danger
                icon={<Square size={14} />}
                size="small"
                title={t('chat.stop')}
                type="text"
                onClick={() => void stop()}
              />
            )}
            <Button
              aria-label={t('common.close')}
              danger
              icon={<X size={14} />}
              size="small"
              type="text"
              onClick={() => void close('close_button')}
            />
          </div>
        </header>
        <CaptureErrorBanner />
        {tool?.builtin_key === 'translate' && tool.kind === 'ai' && <TranslateBar />}
        <main
          aria-live="polite"
          className="selection-toolbar__result-content"
          ref={contentRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottomRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight
                < AUTO_SCROLL_BOTTOM_THRESHOLD;
          }}
        >
          {pending?.input?.kind === 'text' && (
            <div className="selection-toolbar__source">
              <label htmlFor="selection-toolbar-source">{t('settings.selectionToolbar.sourceText')}</label>
              <Input.TextArea
                aria-label={t('settings.selectionToolbar.sourceText')}
                autoSize={{ minRows: 3, maxRows: 8 }}
                disabled={busy}
                id="selection-toolbar-source"
                value={pending.input.text}
                onChange={(event) => updatePending({ sourceText: event.target.value })}
              />
            </div>
          )}
          {pending?.input?.kind === 'screenshot' && (
            <ScreenshotPreview selectionId={pending.selection_id} />
          )}
          {!pending && history.map((turn) => (
            <ResultTurnContent
              isCurrent={false}
              isDark={session?.theme === 'dark'}
              key={turn.request_id}
              turn={turn}
            />
          ))}
          {!pending && run && <ResultTurnContent
            isCurrent
            isDark={session?.theme === 'dark'}
            turn={run}
          />}
        </main>
        <div className="selection-toolbar__composer">
          {error && (pending || error !== run?.error) && (
            <div className="selection-toolbar__composer-error" role="alert">{executionErrorMessage(error, t)}</div>
          )}
          <div className="selection-toolbar__composer-row">
            <Input.TextArea
              aria-label={t(pending ? 'settings.selectionToolbar.additionalInstructions' : 'settings.selectionToolbar.followUpPlaceholder')}
              autoSize={{ minRows: 1, maxRows: 3 }}
              autoFocus={Boolean(pending)}
              disabled={(!pending && !followUpAvailable) || busy}
              placeholder={t(pending ? 'settings.selectionToolbar.additionalInstructionsPlaceholder' : 'settings.selectionToolbar.followUpPlaceholder')}
              value={pending?.user_input ?? draft}
              variant="borderless"
              onChange={(event) => pending
                ? updatePending({ userInput: event.target.value })
                : setDraft(event.target.value)}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onKeyDown={(event) => {
                const nativeEvent = event.nativeEvent;
                if (
                  event.key !== 'Enter'
                  || event.shiftKey
                  || composingRef.current
                  || nativeEvent.isComposing
                  || nativeEvent.keyCode === 229
                ) return;
                event.preventDefault();
                submitFollowUp();
              }}
            />
            <Button
              aria-label={t(pending ? 'settings.selectionToolbar.sendInitial' : 'settings.selectionToolbar.followUpSend')}
              disabled={sendDisabled}
              icon={<SendHorizontal size={15} />}
              size="small"
              title={t(pending ? 'settings.selectionToolbar.sendInitial' : 'settings.selectionToolbar.followUpSend')}
              type="primary"
              onClick={submitFollowUp}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

export function SelectionToolbarApp() {
  const initialize = useSelectionToolbarStore((state) => state.initialize);
  const dispose = useSelectionToolbarStore((state) => state.dispose);
  const session = useSelectionToolbarStore((state) => state.session);
  const surface = useSelectionToolbarStore((state) => state.surface);
  const requestId = useSelectionToolbarStore((state) => state.run?.request_id);
  const pending = useSelectionToolbarStore((state) => state.pendingRequest);
  const captureError = useSelectionToolbarStore((state) => state.captureError);
  const ensureSettingsLoaded = useSettingsStore((state) => state.ensureSettingsLoaded);
  const appearance = session ?? captureError;

  useEffect(() => {
    // The window resizes/moves under a stationary cursor when the surface
    // changes, so mouseleave may never fire — drop any stale hover marks.
    document.querySelectorAll<HTMLElement>('[data-hover]').forEach((element) => {
      delete element.dataset.hover;
    });
  }, [surface, requestId, session?.selection_id]);

  useEffect(() => {
    void initialize();
    return dispose;
  }, [dispose, initialize]);

  useEffect(() => {
    // Same renderer environment as the chat window: settings for code themes,
    // D2 + monaco warmup so result markdown renders 1:1.
    void ensureSettingsLoaded().catch(() => {});
    enableD2(() => import('@terrastruct/d2'));
    void preloadChatRenderers();
  }, [ensureSettingsLoaded]);

  useEffect(() => {
    if (!appearance) return;
    document.documentElement.dataset.theme = appearance.theme;
    document.documentElement.lang = appearance.language;
    document.documentElement.dir = i18n.dir(appearance.language);
    void i18n.changeLanguage(appearance.language).then(() => {
      applyMarkstreamI18nMap(i18n.getFixedT(appearance.language));
    });
  }, [appearance]);

  if (captureError && (!session || (!pending && !requestId))) return (
    <div className="selection-toolbar__result-stack">
      <ToolbarSurface />
      <section className="selection-toolbar__result"><CaptureErrorBanner /></section>
    </div>
  );
  if (!session) return null;
  if (surface === 'result') return <ResultSurface key={session.selection_id} />;
  return <ToolbarSurfaceHost expanded={surface === 'overflow'} />;
}

export function SelectionToolbarRoot() {
  const theme = useSelectionToolbarStore((state) => state.session?.theme ?? state.captureError?.theme ?? 'light');
  const language = useSelectionToolbarStore((state) => state.session?.language ?? state.captureError?.language ?? 'en-US');
  return (
    <ConfigProvider
      direction={i18n.dir(language)}
      theme={{
        algorithm: theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { borderRadius: 8, colorPrimary: '#17A93D' },
      }}
    >
      <SelectionToolbarApp />
    </ConfigProvider>
  );
}
