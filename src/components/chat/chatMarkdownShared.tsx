import { useEffect, useMemo, useRef, useState } from 'react';
import { SyncOutlined } from '@ant-design/icons';
import { Brain } from 'lucide-react';
import Think from '@ant-design/x/es/think';
import NodeRenderer, {
  type CodeBlockActionContext,
  type CodeBlockPreviewPayload,
  type InfographicBlockActionContext,
  type MermaidBlockActionContext,
  type NodeComponentProps,
} from 'markstream-react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@/stores';
import { quoteCssFontFamily } from '@/lib/cssFontFamily';
import {
  CHAT_CUSTOM_HTML_TAGS,
  safeParseChatMarkdown,
  type ChatMarkdownNode,
} from '@/lib/chatMarkdown';
import { formatDuration } from '../gateway/tokenFormat';
import { getOrParseThinkingNodes } from './chatRetainedCaches';
import { THINKING_LOADING_MARKER } from './chatStreaming';
import { CodeBlockHeaderActions } from './CodeBlockHeaderActions';
import { MermaidBlockHeaderActions } from './MermaidBlockHeaderActions';
import { InfographicBlockHeaderActions } from './InfographicBlockHeaderActions';
import { DiagramModeToggle } from './DiagramModeToggle';
import { MermaidZoomControls } from './MermaidZoomControls';

// Shared markdown rendering pieces used by both the chat view and the
// selection toolbar result panel, so both surfaces render 1:1.

export const DEFAULT_LIGHT_CODE_BLOCK_THEME = 'github-light';
export const DEFAULT_DARK_CODE_BLOCK_THEME = 'poimandres';

export const CHAT_RENDER_BATCH_PROPS = {
  viewportPriority: true,
  deferNodesUntilVisible: false,
  initialRenderBatchSize: 24,
  renderBatchSize: 48,
  renderBatchDelay: 24,
  renderBatchBudgetMs: 4,
  maxLiveNodes: 480,
  liveNodeBuffer: 96,
} as const;

export type CustomNodeAttrs =
  | Record<string, string | boolean>
  | [string, string][]
  | Array<{ name: string; value: string | boolean }>
  | null
  | undefined;

function normalizeCodeTheme(raw?: string) {
  const t = raw?.trim();
  if (t === 'vs-code' || t === 'vscode') return 'dark-plus';
  if (t === 'one-dark') return 'one-dark-pro';
  return t || undefined;
}

export function getChatCodeThemes(selectedDarkTheme?: string, selectedLightTheme?: string) {
  const darkTheme = normalizeCodeTheme(selectedDarkTheme) || DEFAULT_DARK_CODE_BLOCK_THEME;
  const lightTheme = normalizeCodeTheme(selectedLightTheme) || DEFAULT_LIGHT_CODE_BLOCK_THEME;
  return {
    darkTheme,
    lightTheme,
    themes: Array.from(new Set([lightTheme, darkTheme])),
  };
}

let _codeBlockPreviewHandler: ((payload: CodeBlockPreviewPayload) => void) | null = null;
let _mermaidOpenModalHandler: ((svgString: string | null) => void) | null = null;

export function setCodeBlockPreviewHandler(
  handler: ((payload: CodeBlockPreviewPayload) => void) | null,
) {
  _codeBlockPreviewHandler = handler;
}

export function setMermaidOpenModalHandler(
  handler: ((svgString: string | null) => void) | null,
) {
  _mermaidOpenModalHandler = handler;
}

export function getChatCodeBlockProps(darkTheme: string, lightTheme: string) {
  return {
    darkTheme,
    lightTheme,
    renderHeaderActions: (ctx: CodeBlockActionContext) => (
      <CodeBlockHeaderActions ctx={ctx} />
    ),
    onPreviewCode: (payload: CodeBlockPreviewPayload) => {
      _codeBlockPreviewHandler?.(payload);
    },
  };
}

export const CHAT_MERMAID_PROPS = {
  renderHeaderActions: (ctx: MermaidBlockActionContext) => (
    <MermaidBlockHeaderActions ctx={ctx} />
  ),
  renderModeToggle: (ctx: MermaidBlockActionContext) => (
    <DiagramModeToggle showSource={ctx.showSource} onSwitchMode={ctx.switchMode} />
  ),
  renderZoomControls: (ctx: MermaidBlockActionContext) => (
    <MermaidZoomControls ctx={ctx} />
  ),
  onOpenModal: (ev: { preventDefault: () => void; svgString?: string | null }) => {
    if (_mermaidOpenModalHandler) {
      ev.preventDefault();
      _mermaidOpenModalHandler(ev.svgString ?? null);
    }
  },
};

export const CHAT_INFOGRAPHIC_PROPS = {
  renderHeaderActions: (ctx: InfographicBlockActionContext) => (
    <InfographicBlockHeaderActions ctx={ctx} />
  ),
  renderModeToggle: (ctx: InfographicBlockActionContext) => (
    <DiagramModeToggle showSource={ctx.showSource} onSwitchMode={ctx.switchMode} />
  ),
  renderZoomControls: (ctx: InfographicBlockActionContext) => (
    <MermaidZoomControls ctx={ctx as any} />
  ),
};

export interface ChatMarkdownRendererProps {
  content?: string;
  nodes?: readonly ChatMarkdownNode[] | null;
  isDark: boolean;
  final: boolean;
  customId: string;
  codeBlockDarkTheme: string;
  codeBlockLightTheme: string;
  codeBlockThemes: string[];
  codeFontFamily?: string;
}

export function ChatMarkdownRenderer({
  content,
  nodes,
  isDark,
  final,
  customId,
  codeBlockDarkTheme,
  codeBlockLightTheme,
  codeBlockThemes,
  codeFontFamily,
}: ChatMarkdownRendererProps) {
  const codeBlockProps = useMemo(
    () => getChatCodeBlockProps(codeBlockDarkTheme, codeBlockLightTheme),
    [codeBlockDarkTheme, codeBlockLightTheme],
  );
  const codeBlockMonacoOptions = useMemo(
    () => codeFontFamily ? { fontFamily: quoteCssFontFamily(codeFontFamily) } : undefined,
    [codeFontFamily],
  );

  return (
    <NodeRenderer
      content={content}
      nodes={nodes}
      isDark={isDark}
      customId={customId}
      customHtmlTags={CHAT_CUSTOM_HTML_TAGS}
      final={final}
      typewriter={false}
      themes={codeBlockThemes}
      codeBlockLightTheme={codeBlockLightTheme}
      codeBlockDarkTheme={codeBlockDarkTheme}
      codeBlockProps={codeBlockProps}
      codeBlockMonacoOptions={codeBlockMonacoOptions}
      mermaidProps={CHAT_MERMAID_PROPS}
      infographicProps={CHAT_INFOGRAPHIC_PROPS}
      {...CHAT_RENDER_BATCH_PROPS}
    />
  );
}

export function getCustomAttr(attrs: CustomNodeAttrs, name: string): string | undefined {
  if (!attrs) return undefined;

  if (Array.isArray(attrs)) {
    for (const attr of attrs) {
      if (Array.isArray(attr)) {
        const [attrName, value] = attr;
        if (attrName === name) return value;
        continue;
      }

      if (attr && typeof attr === 'object' && 'name' in attr && attr.name === name) {
        return typeof attr.value === 'string' ? attr.value : undefined;
      }
    }
    return undefined;
  }

  const value = attrs[name];
  return typeof value === 'string' ? value : undefined;
}

export function ThinkNode(props: NodeComponentProps<{
  type: 'think';
  content: string;
  attrs?: CustomNodeAttrs;
}>) {
  const { t } = useTranslation();
  const selectedDarkCodeTheme = useSettingsStore((s) => s.settings.code_theme);
  const selectedLightCodeTheme = useSettingsStore((s) => s.settings.code_theme_light);
  const codeFontFamily = useSettingsStore((s) => s.settings.code_font_family);
  const { node, ctx } = props;
  const thinkingNodesCacheRef = useRef<Map<string, ChatMarkdownNode[]>>(new Map());
  const rawThinkingContent = String(node.content ?? '');
  const isStreaming = rawThinkingContent.includes(THINKING_LOADING_MARKER);
  const totalMsAttr = getCustomAttr(node.attrs, 'totalMs') ?? getCustomAttr(node.attrs, 'totalms');
  const totalMs = totalMsAttr ? parseInt(totalMsAttr, 10) : null;
  const thinkingContent = rawThinkingContent
    .replace(`${THINKING_LOADING_MARKER}\n`, '')
    .replace(THINKING_LOADING_MARKER, '');
  const [expanded, setExpanded] = useState(isStreaming);
  const prevStreamingRef = useRef(isStreaming);

  useEffect(() => {
    setExpanded(isStreaming);
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    if (isStreaming) {
      setExpanded(true);
    } else if (prevStreamingRef.current) {
      setExpanded(false);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const title = isStreaming
    ? t('chat.thinkingInProgress')
    : totalMs && !isNaN(totalMs)
      ? `${t('chat.thinkingComplete')} ${formatDuration(totalMs)}`
      : t('chat.thinkingComplete');

  const thinkingNodes = useMemo(() => {
    return getOrParseThinkingNodes(
      thinkingNodesCacheRef.current,
      thinkingContent,
      isStreaming,
      safeParseChatMarkdown,
    );
  }, [isStreaming, thinkingContent]);
  const { darkTheme, lightTheme, themes } = useMemo(
    () => getChatCodeThemes(selectedDarkCodeTheme, selectedLightCodeTheme),
    [selectedDarkCodeTheme, selectedLightCodeTheme],
  );
  const codeBlockProps = useMemo(
    () => getChatCodeBlockProps(darkTheme, lightTheme),
    [darkTheme, lightTheme],
  );
  const codeBlockMonacoOptions = useMemo(
    () => codeFontFamily ? { fontFamily: quoteCssFontFamily(codeFontFamily) } : undefined,
    [codeFontFamily],
  );
  const rendererKey = `${ctx?.customId ?? 'default'}:${ctx?.isDark ? 'dark' : 'light'}:${darkTheme}:${lightTheme}`;

  return (
    <Think
      title={title}
      blink={isStreaming}
      loading={isStreaming ? (
        <SyncOutlined style={{ fontSize: 12, animation: 'aqbot-think-spin 1s linear infinite' }} />
      ) : false}
      icon={<Brain size={14} />}
      expanded={expanded}
      onExpand={setExpanded}
    >
      <NodeRenderer
        key={rendererKey}
        nodes={thinkingNodes}
        customId={ctx?.customId}
        isDark={ctx?.isDark}
        final={!isStreaming}
        typewriter={false}
        themes={themes}
        codeBlockLightTheme={lightTheme}
        codeBlockDarkTheme={darkTheme}
        codeBlockProps={codeBlockProps}
        codeBlockMonacoOptions={codeBlockMonacoOptions}
        customHtmlTags={CHAT_CUSTOM_HTML_TAGS.filter((t) => t !== 'think')}
        mermaidProps={CHAT_MERMAID_PROPS}
        infographicProps={CHAT_INFOGRAPHIC_PROPS}
        {...CHAT_RENDER_BATCH_PROPS}
      />
    </Think>
  );
}
