import { useEffect, useMemo, useRef } from 'react';
import { Button, ConfigProvider, Select, Spin, theme as antdTheme } from 'antd';
import {
  ArrowLeftRight,
  Check,
  Copy,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import NodeRenderer, { enableD2, setCustomComponents } from 'markstream-react';
import { registerHighlight } from 'stream-markdown';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import type { SelectionToolbarToolView } from '@/types';
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

function beginWindowDrag() {
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
    .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().startDragging())
    .catch(clear);
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
  const activeToolId = useSelectionToolbarStore((state) => state.run?.tool_id);
  const executeTool = useSelectionToolbarStore((state) => state.executeTool);
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
      onDragPointerDown={beginWindowDrag}
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
        disabled={translateSource === 'auto'}
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

function ResultSurface() {
  const { t } = useTranslation();
  const session = useSelectionToolbarStore((state) => state.session);
  const run = useSelectionToolbarStore((state) => state.run);
  const copied = useSelectionToolbarStore((state) => state.copied);
  const stop = useSelectionToolbarStore((state) => state.stop);
  const copyResult = useSelectionToolbarStore((state) => state.copyResult);
  const regenerate = useSelectionToolbarStore((state) => state.regenerate);
  const close = useSelectionToolbarStore((state) => state.close);
  const contentRef = useRef<HTMLElement | null>(null);
  const stickToBottomRef = useRef(true);
  const requestId = run?.request_id;

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [requestId]);

  useEffect(() => {
    const element = contentRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [requestId, run?.output]);

  if (!run) return null;
  const streaming = run.status === 'started' || run.status === 'streaming';
  const tool = session?.tools.find((candidate) => candidate.id === run.tool_id);
  const title = tool
    ? t('settings.selectionToolbar.aiFeatureTitle', { feature: labelFor(tool, t) })
    : t('settings.selectionToolbar.result');

  return (
    <div className="selection-toolbar__result-stack">
      <ToolbarSurface />
      <section className="selection-toolbar__result">
        <header className="selection-toolbar__result-header">
          <div className="selection-toolbar__result-title">
            {streaming && <Spin size="small" />}
            <span>{title}</span>
          </div>
          <div className="selection-toolbar__result-actions">
            {run.output && (
              <Button
                aria-label={t('common.copy')}
                icon={copied ? <Check size={14} /> : <Copy size={14} />}
                size="small"
                type="text"
                onClick={() => void copyResult()}
              />
            )}
            <Button
              aria-label={t('chat.regenerate')}
              disabled={streaming}
              icon={<RotateCcw size={14} />}
              size="small"
              title={t('chat.regenerate')}
              type="text"
              onClick={() => void regenerate()}
            />
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
          {run.error ? (
            <div className="selection-toolbar__error">{run.error}</div>
          ) : run.output ? (
            <ResultMarkdown
              isDark={session?.theme === 'dark'}
              output={run.output}
              streaming={streaming}
            />
          ) : (
            <div className="selection-toolbar__waiting">{t('chat.thinkingInProgress')}</div>
          )}
        </main>
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
  const ensureSettingsLoaded = useSettingsStore((state) => state.ensureSettingsLoaded);

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
    if (!session) return;
    document.documentElement.dataset.theme = session.theme;
    document.documentElement.lang = session.language;
    document.documentElement.dir = i18n.dir(session.language);
    void i18n.changeLanguage(session.language).then(() => {
      applyMarkstreamI18nMap(i18n.getFixedT(session.language));
    });
  }, [session]);

  if (!session) return null;
  if (surface === 'result') return <ResultSurface />;
  return <ToolbarSurfaceHost expanded={surface === 'overflow'} />;
}

export function SelectionToolbarRoot() {
  const theme = useSelectionToolbarStore((state) => state.session?.theme ?? 'light');
  const language = useSelectionToolbarStore((state) => state.session?.language ?? 'en-US');
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
