import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { CloseCircleFilled, SyncOutlined } from '@ant-design/icons';
import { Typography, Button, Dropdown, Input, App, Avatar, Alert, Popconfirm, Popover, theme, Tag, Image, Tooltip, Modal, Spin } from 'antd';
import type { InputRef } from 'antd';
import { Pencil, Share2, FileImage, FileCode, FileText, FileType, Bot, Brain, Lightbulb, Code, Languages, Copy, Check, RotateCcw, User, Trash2, ChevronLeft, ChevronRight, ChevronDown, Scissors, Paperclip, AlertCircle, X, ArrowDown, ArrowUp, ArrowLeftRight, Zap, Sparkles, TextCursorInput, GitBranch, ChartNoAxesColumn, MessageSquare, ArrowUpRight, ArrowDownRight, Coins, Clock, Timer, Download } from 'lucide-react';
import { ModelIcon } from '@lobehub/icons';
import { getConvIcon } from '@/lib/convIcon';
import Bubble from '@ant-design/x/es/bubble';
import Prompts from '@ant-design/x/es/prompts';
import Actions from '@ant-design/x/es/actions';
import Think from '@ant-design/x/es/think';
import type { BubbleItemType, BubbleListRef, RoleType } from '@ant-design/x/es/bubble/interface';
import type { PromptsItemType } from '@ant-design/x/es/prompts';
import NodeRenderer, { setCustomComponents, type NodeComponentProps, type CodeBlockActionContext, type CodeBlockPreviewPayload, type MermaidBlockActionContext, type InfographicBlockActionContext } from 'markstream-react';
import { useTranslation } from 'react-i18next';
import { CodeBlockHeaderActions } from './CodeBlockHeaderActions';
import { CodeBlockPreviewModal } from './CodeBlockPreviewModal';
import { MermaidBlockHeaderActions } from './MermaidBlockHeaderActions';
import { InfographicBlockHeaderActions } from './InfographicBlockHeaderActions';
import { DiagramModeToggle } from './DiagramModeToggle';
import { MermaidZoomControls } from './MermaidZoomControls';
import { useConversationStore, useProviderStore, useSettingsStore, useAgentStore } from '@/stores';
import { setupAgentEventListeners } from '@/stores/agentStore';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { useResolvedDarkMode } from '@/hooks/useResolvedDarkMode';
import { InputArea } from './InputArea';
import { ModelSelector } from './ModelSelector';
import { parseSearchContent } from '@/lib/searchUtils';
import { CHAT_CUSTOM_HTML_TAGS, parseChatMarkdown, stripAqbotTags, type ChatMarkdownNode } from '@/lib/chatMarkdown';
import {
  hasMultipleModelVersions,
  selectRenderableVersionSet,
  shouldRenderStandaloneAssistantError,
} from '@/lib/chatMultiModel';
import { WebSearchNode } from './WebSearchNode';
import { MemoryRetrievalNode } from './MemoryRetrievalNode';
import { KnowledgeRetrievalNode } from './KnowledgeRetrievalNode';
import { McpContainerNode } from './McpContainerNode';
import {
  CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD,
  CHAT_SCROLL_IS_REVERSED,
  getDistanceToHistoryTop,
  getScrollTopAfterPrepend,
  hasMeasuredScrollLayoutChanged,
  hasScrollLayoutMetricsChanged,
  resolveChatScrollElements,
  shouldIgnoreScrollDepartureFromBottom,
  shouldKeepAutoScroll,
  shouldStickToBottomOnLayoutChange,
  shouldShowScrollToBottom,
} from './chatScroll';
import { formatTokenCount, formatSpeed, formatDuration } from '../gateway/tokenFormat';
import {
  getStreamingLoadingState,
  hasAqbotDisplayContent,
  hasModelVisibleContent,
  shouldRenderAssistantMarkdownFromContent,
  splitLeadingAqbotDisplayContent,
  stripLeadingAqbotDisplayTags,
} from './chatStreaming';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { buildAssistantDisplayContent, shouldHideAssistantBubble } from './toolCallDisplay';
import { ChatScrollIndicator } from './ChatScrollIndicator';
import { ChatMinimap, MinimapScrollProvider } from './ChatMinimap';
import { MultiModelDisplay, LayoutSwitcher, type MultiModelDisplayMode } from './MultiModelDisplay';
import PermissionCard from './PermissionCard';
import AskUserCard from './AskUserCard';
import { ChatImageNode } from './ChatImageNode';
import { formatChatTime } from './chatTime';

import { invoke } from '@/lib/invoke';
import { registerHighlight } from 'stream-markdown';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import type { Message, Attachment, ConversationStats } from '@/types';

// ── markstream-react custom thinking component ──────────────────────────

const THINKING_LOADING_MARKER = '<!--aqbot-thinking-loading-->';
const DEFAULT_LIGHT_CODE_BLOCK_THEME = 'github-light';
const DEFAULT_DARK_CODE_BLOCK_THEME = 'poimandres';
const DANGEROUS_D2_STYLE_PATTERNS = [
  /javascript:/i,
  /expression\s*\(/i,
  /url\s*\(\s*javascript:/i,
  /@import/i,
] as const;
const SAFE_D2_URL_PATTERN = /^(?:https?:|mailto:|tel:|#|\/|data:image\/(?:png|gif|jpe?g|webp);)/i;
const CHAT_D2_DARK_THEME_ID = 200;
const CHAT_RENDER_BATCH_PROPS = {
  viewportPriority: true,
  deferNodesUntilVisible: false,
  initialRenderBatchSize: 24,
  renderBatchSize: 48,
  renderBatchDelay: 24,
  renderBatchBudgetMs: 4,
  maxLiveNodes: Infinity,
  liveNodeBuffer: 24,
} as const;
const USER_SCROLL_INTENT_GRACE_MS = 250;

// ── Attachment preview component ────────────────────────────────────────

const ATTACHMENT_IMG_STYLE: React.CSSProperties = {
  maxWidth: 200,
  maxHeight: 160,
  borderRadius: 8,
  objectFit: 'cover' as const,
};

function AttachmentPreview({ att, themeColor }: { att: Attachment; themeColor: string }) {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const isImage = att.file_type?.startsWith('image/');
  const [src, setSrc] = React.useState<string | null>(() => {
    if (!isImage) return null;
    if (att.data) return `data:${att.file_type};base64,${att.data}`;
    return null;
  });
  const [failed, setFailed] = React.useState(false);
  const [fileExists, setFileExists] = React.useState<boolean | null>(null);

  // Check file existence for all attachments
  React.useEffect(() => {
    if (!att.file_path) { setFileExists(false); return; }
    let cancelled = false;
    invoke<boolean>('check_attachment_exists', { filePath: att.file_path })
      .then((exists) => { if (!cancelled) setFileExists(exists); })
      .catch(() => { if (!cancelled) setFileExists(false); });
    return () => { cancelled = true; };
  }, [att.file_path]);

  // Load image preview (only if file exists)
  React.useEffect(() => {
    if (!isImage || src || failed) return;
    if (!att.file_path || fileExists === false) { setFailed(true); return; }
    if (fileExists === null) return; // still checking
    let cancelled = false;
    invoke<string>('read_attachment_preview', { filePath: att.file_path })
      .then((dataUrl) => { if (!cancelled) setSrc(dataUrl); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [isImage, att.file_path, src, failed, fileExists]);

  // Deleted/missing file — show red error tag, click to show location modal
  if (fileExists === false) {
    const showMissingModal = () => {
      invoke<string>('resolve_attachment_path', { filePath: att.file_path })
        .then((absPath) => {
          modal.confirm({
            icon: <CloseCircleFilled style={{ color: '#ff4d4f' }} />,
            title: t('chat.attachmentNotFound'),
            content: absPath,
            okText: t('chat.attachmentOk'),
            cancelText: t('chat.attachmentRevealLocation'),
            onCancel: () => {
              invoke('reveal_attachment_file', { filePath: att.file_path }).catch(() => {});
            },
          });
        })
        .catch(() => {
          modal.error({
            title: t('chat.attachmentNotFound'),
            content: att.file_path || att.file_name,
            okText: t('chat.attachmentOk'),
          });
        });
    };
    return (
      <Tag
        icon={<AlertCircle size={12} />}
        color="error"
        style={{ margin: 0, cursor: 'pointer' }}
        onClick={showMissingModal}
      >
        {att.file_name}
      </Tag>
    );
  }

  // Still checking existence — show neutral loading tag
  if (fileExists === null && !src) {
    return (
      <Tag
        icon={isImage ? <FileImage size={12} /> : <Paperclip size={12} />}
        style={{ margin: 0, cursor: 'default', opacity: 0.5 }}
      >
        {att.file_name}
      </Tag>
    );
  }

  if (isImage && src) {
    return (
      <Image
        src={src}
        alt={att.file_name}
        style={ATTACHMENT_IMG_STYLE}
        preview={{ mask: { blur: true }, scaleStep: 0.5 }}
      />
    );
  }

  const handleOpen = () => {
    if (att.file_path) {
      invoke('open_attachment_file', { filePath: att.file_path }).catch(() => {});
    }
  };

  const handleReveal = () => {
    if (att.file_path) {
      invoke('reveal_attachment_file', { filePath: att.file_path }).catch(() => {});
    }
  };

  const contextMenuItems = att.file_path
    ? [
        { key: 'open', label: t('chat.attachmentOpen'), onClick: handleOpen },
        { key: 'reveal', label: t('chat.attachmentRevealInFinder'), onClick: handleReveal },
      ]
    : [];

  const tag = (
    <Tag
      icon={isImage ? <FileImage size={12} /> : <Paperclip size={12} />}
      color={themeColor}
      style={{ margin: 0, cursor: att.file_path ? 'pointer' : 'default' }}
      onClick={att.file_path ? handleOpen : undefined}
    >
      {att.file_name}
    </Tag>
  );

  if (!att.file_path) return tag;

  return (
    <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
      {tag}
    </Dropdown>
  );
}

type CustomNodeAttrs =
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

function getChatCodeThemes(selectedDarkTheme?: string, selectedLightTheme?: string) {
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

function getChatCodeBlockProps(darkTheme: string, lightTheme: string) {
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

const CHAT_MERMAID_PROPS = {
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

const CHAT_INFOGRAPHIC_PROPS = {
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

function getCustomAttr(attrs: CustomNodeAttrs, name: string): string | undefined {
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

function isChatD2CodeBlockNode(node: ChatMarkdownNode): node is ChatD2CodeBlockNode {
  return node.type === 'code_block'
    && 'code' in node
    && typeof node.code === 'string'
    && (!('language' in node) || typeof node.language === 'string' || typeof node.language === 'undefined');
}

function getSingleD2CodeBlockNode(nodes?: ChatMarkdownNode[]) {
  if (!nodes || nodes.length !== 1) return null;

  const [firstNode] = nodes;
  if (!isChatD2CodeBlockNode(firstNode) || firstNode.language?.trim().toLowerCase() !== 'd2') {
    return null;
  }

  return firstNode;
}

function containsDeferredHeavyNode(nodes?: ChatMarkdownNode[]) {
  if (!nodes) return false;

  const stack: unknown[] = [...nodes];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }

    if ('type' in current && current.type === 'code_block') {
      return true;
    }

    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        stack.push(...value);
      }
    }
  }

  return false;
}

function sanitizeD2Url(url: string) {
  const value = url.trim();
  return SAFE_D2_URL_PATTERN.test(value) ? value : '';
}

function sanitizeD2Svg(svg: string) {
  if (typeof document === 'undefined' || typeof DOMParser === 'undefined') {
    return '';
  }

  const sanitizeTree = (root: Element) => {
    const blockedTags = new Set(['script']);
    const nodes = [root, ...Array.from(root.querySelectorAll('*'))];

    for (const element of nodes) {
      if (blockedTags.has(element.tagName.toLowerCase())) {
        element.remove();
        continue;
      }

      for (const attr of Array.from(element.attributes)) {
        const name = attr.name;
        if (/^on/i.test(name)) {
          element.removeAttribute(name);
          continue;
        }

        if (name === 'style' && attr.value && DANGEROUS_D2_STYLE_PATTERNS.some((pattern) => pattern.test(attr.value))) {
          element.removeAttribute(name);
          continue;
        }

        if ((name === 'href' || name === 'xlink:href') && attr.value) {
          const safeUrl = sanitizeD2Url(attr.value);
          if (!safeUrl) {
            element.removeAttribute(name);
            continue;
          }
          if (safeUrl !== attr.value) {
            element.setAttribute(name, safeUrl);
          }
        }
      }
    }
  };

  const normalizedSvg = svg
    .replace(/["']\s*javascript:/gi, '#')
    .replace(/\bjavascript:/gi, '#')
    .replace(/["']\s*vbscript:/gi, '#')
    .replace(/\bvbscript:/gi, '#')
    .replace(/\bdata:text\/html/gi, '#');

  const xmlRoot = new DOMParser().parseFromString(normalizedSvg, 'image/svg+xml').documentElement;
  if (xmlRoot && xmlRoot.nodeName.toLowerCase() === 'svg') {
    sanitizeTree(xmlRoot);
    return xmlRoot.outerHTML;
  }

  const container = document.createElement('div');
  container.innerHTML = normalizedSvg;
  const htmlSvg = container.querySelector('svg');
  if (!htmlSvg) {
    return '';
  }

  sanitizeTree(htmlSvg);
  return htmlSvg.outerHTML;
}

type ChatD2Instance = {
  compile: (source: string) => Promise<unknown>;
  render: (diagram: unknown, options?: unknown) => Promise<unknown>;
};

type ChatD2Constructor = new () => ChatD2Instance;

let chatD2CtorPromise: Promise<ChatD2Constructor> | null = null;

async function loadChatD2Ctor() {
  if (!chatD2CtorPromise) {
    chatD2CtorPromise = import('@terrastruct/d2').then((module) => {
      if (typeof module.D2 !== 'function') {
        throw new Error('Failed to resolve D2 constructor from @terrastruct/d2.');
      }

      return module.D2 as ChatD2Constructor;
    });
  }

  return chatD2CtorPromise;
}

function ThinkNode(props: NodeComponentProps<{
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
    const cache = thinkingNodesCacheRef.current;
    const cached = cache.get(thinkingContent);
    if (cached) return cached;

    const parsed = parseChatMarkdown(thinkingContent);
    cache.set(thinkingContent, parsed);
    if (cache.size > 24) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    return parsed;
  }, [thinkingContent]);
  const { darkTheme, lightTheme, themes } = useMemo(
    () => getChatCodeThemes(selectedDarkCodeTheme, selectedLightCodeTheme),
    [selectedDarkCodeTheme, selectedLightCodeTheme],
  );
  const codeBlockProps = useMemo(
    () => getChatCodeBlockProps(darkTheme, lightTheme),
    [darkTheme, lightTheme],
  );
  const codeBlockMonacoOptions = useMemo(
    () => codeFontFamily ? { fontFamily: codeFontFamily } : undefined,
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

type ChatD2CodeBlockNode = {
  type: 'code_block';
  language?: string;
  code: string;
  raw: string;
  loading?: boolean;
};

function ChatD2BlockNode({
  node,
  isDark,
}: {
  node: ChatD2CodeBlockNode;
  isDark?: boolean;
}) {
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { copy: copyD2, isCopied: d2Copied } = useCopyToClipboard({ timeout: 1000 });
  const [svgMarkup, setSvgMarkup] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [canRenderPreview, setCanRenderPreview] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  useEffect(() => {
    setCanRenderPreview(false);
    if (showSource) return;

    const element = containerRef.current;
    if (!element || typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      setCanRenderPreview(true);
      return;
    }

    let frameId = 0;
    let timeoutId: number | null = null;
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      frameId = window.requestAnimationFrame(() => {
        if (typeof win.requestIdleCallback === 'function') {
          timeoutId = win.requestIdleCallback(() => setCanRenderPreview(true), { timeout: 250 });
          return;
        }
        timeoutId = window.setTimeout(() => setCanRenderPreview(true), 0);
      });
    }, { rootMargin: '160px 0px' });

    observer.observe(element);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frameId);
      if (timeoutId !== null) {
        if (typeof win.cancelIdleCallback === 'function') {
          win.cancelIdleCallback(timeoutId);
        } else {
          window.clearTimeout(timeoutId);
        }
      }
    };
  }, [node.code, showSource]);

  useEffect(() => {
    let cancelled = false;
    if (!canRenderPreview || showSource) {
      return () => {
        cancelled = true;
      };
    }

    const renderD2 = async () => {
      const source = String(node.code ?? '');
      if (!source) {
        setSvgMarkup('');
        setError(null);
        return;
      }

      setError(null);

      try {
        const D2Ctor = await loadChatD2Ctor();
        const instance = new D2Ctor();
        const compiled = await instance.compile(source) as {
          diagram?: unknown;
          renderOptions?: Record<string, unknown>;
          options?: Record<string, unknown>;
        } | unknown;
        const diagram = typeof compiled === 'object' && compiled !== null && 'diagram' in compiled
          ? compiled.diagram
          : compiled;
        const renderOptions = typeof compiled === 'object' && compiled !== null
          ? ('renderOptions' in compiled && compiled.renderOptions) || ('options' in compiled && compiled.options) || {}
          : {};
        const nextRenderOptions = typeof renderOptions === 'object' && renderOptions !== null
          ? { ...renderOptions as Record<string, unknown> }
          : {};

        if (isDark) {
          nextRenderOptions.themeID = typeof nextRenderOptions.darkThemeID === 'number'
            ? nextRenderOptions.darkThemeID
            : CHAT_D2_DARK_THEME_ID;
          nextRenderOptions.darkThemeID = null;
          nextRenderOptions.darkThemeOverrides = null;
          nextRenderOptions.themeOverrides = {
            N1: token.colorText,
            N2: token.colorTextSecondary,
            N3: token.colorTextTertiary,
            N4: token.colorTextQuaternary,
            N5: token.colorBorder,
            N6: token.colorBorderSecondary,
            N7: token.colorBgContainer,
            B1: token.colorText,
            B2: token.colorTextSecondary,
            B3: token.colorTextTertiary,
            B4: token.colorBorder,
            B5: token.colorBorderSecondary,
            B6: token.colorBgElevated,
            AA2: token.colorTextSecondary,
            AA4: token.colorTextTertiary,
            AA5: token.colorBorder,
            AB4: token.colorTextSecondary,
            AB5: token.colorTextTertiary,
            ...(typeof nextRenderOptions.themeOverrides === 'object' && nextRenderOptions.themeOverrides !== null
              ? nextRenderOptions.themeOverrides as Record<string, unknown>
              : {}),
          };
        }

        const rendered = await instance.render(diagram, nextRenderOptions);
        const rawSvg = typeof rendered === 'string'
          ? rendered
          : typeof rendered === 'object' && rendered !== null && 'svg' in rendered && typeof rendered.svg === 'string'
            ? rendered.svg
            : typeof rendered === 'object' && rendered !== null && 'data' in rendered && typeof rendered.data === 'string'
              ? rendered.data
              : '';

        if (!rawSvg) {
          throw new Error('D2 render returned empty output.');
        }

        const sanitizedSvg = sanitizeD2Svg(rawSvg);
        if (!sanitizedSvg) {
          throw new Error('D2 SVG sanitization failed in the current WebView.');
        }

        if (cancelled) return;
        setSvgMarkup(sanitizedSvg);
      } catch (renderError) {
        if (cancelled) return;
        setSvgMarkup('');
        setError(renderError instanceof Error ? renderError.message : 'D2 render failed.');
      }
    };

    void renderD2();

    return () => {
      cancelled = true;
    };
  }, [canRenderPreview, isDark, node.code, showSource, token.colorBgContainer, token.colorBgElevated, token.colorBorder, token.colorBorderSecondary, token.colorText, token.colorTextQuaternary, token.colorTextSecondary, token.colorTextTertiary]);


  const handleExport = useCallback(() => {
    if (!svgMarkup) return;

    const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `d2-diagram-${Date.now()}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [svgMarkup]);

  const shellStyle = useMemo(() => ({
    borderColor: isDark ? token.colorBorderSecondary : token.colorBorderSecondary,
    background: isDark ? token.colorBgElevated : token.colorBgContainer,
    color: token.colorText,
  }), [isDark, token.colorBgContainer, token.colorBgElevated, token.colorBorderSecondary, token.colorText]);

  const headerStyle = useMemo(() => ({
    color: token.colorText,
    backgroundColor: isDark ? token.colorBgContainer : token.colorFillAlter,
    borderBottomColor: token.colorBorderSecondary,
  }), [isDark, token.colorBgContainer, token.colorBorderSecondary, token.colorFillAlter, token.colorText]);

  const getD2BtnStyle = useCallback((idx: number): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: token.borderRadiusSM,
    border: 'none',
    background: hoveredIdx === idx ? (token.colorFillSecondary || 'rgba(255,255,255,0.1)') : 'transparent',
    color: hoveredIdx === idx ? token.colorText : token.colorTextSecondary,
    cursor: 'pointer',
    padding: 0,
    transition: 'color 0.2s, background 0.2s',
  }), [hoveredIdx, token]);

  const previewStyle = useMemo(() => ({
    background: isDark ? token.colorBgContainer : token.colorBgElevated,
  }), [isDark, token.colorBgContainer, token.colorBgElevated]);

  return (
    <div ref={containerRef} className="d2-block my-4 rounded-lg border overflow-hidden shadow-sm" style={shellStyle}>
      <div
        className="d2-block-header flex justify-between items-center px-4 py-1.5 border-b border-gray-400/5"
        style={headerStyle}
      >
        <div className="flex items-center gap-x-2">
          <span className="text-sm font-medium font-mono">D2</span>
        </div>
        <div className="flex items-center gap-x-2">
          <DiagramModeToggle
            showSource={showSource}
            onSwitchMode={(mode) => setShowSource(mode === 'source')}
          />
          {/* Collapse */}
          <Tooltip title={isCollapsed ? t('common.expand') : t('common.collapse')} mouseEnterDelay={0.4}>
            <button type="button" style={getD2BtnStyle(0)} onClick={() => setIsCollapsed(v => !v)}
              onMouseEnter={() => setHoveredIdx(0)} onMouseLeave={() => setHoveredIdx(null)}>
              <ChevronRight
                size={14}
                style={{
                  transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                  transition: 'transform 0.2s',
                }}
              />
            </button>
          </Tooltip>
          {/* Copy */}
          <Tooltip title={d2Copied ? t('common.copied') : t('common.copy')} mouseEnterDelay={0.4}>
            <button type="button" style={getD2BtnStyle(1)} onClick={() => void copyD2(node.code)}
              onMouseEnter={() => setHoveredIdx(1)} onMouseLeave={() => setHoveredIdx(null)}>
              {d2Copied ? <Check size={14} style={{ color: token.colorSuccess }} /> : <Copy size={14} />}
            </button>
          </Tooltip>
          {/* Export */}
          {svgMarkup ? (
            <Tooltip title={t('common.export')} mouseEnterDelay={0.4}>
              <button type="button" style={getD2BtnStyle(2)} onClick={handleExport}
                onMouseEnter={() => setHoveredIdx(2)} onMouseLeave={() => setHoveredIdx(null)}>
                <Download size={14} />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {!isCollapsed && (
        <div className="d2-block-body">
          {showSource || (!svgMarkup && !!error) ? (
            <div className="d2-source px-4 py-4">
              <pre className="d2-code"><code>{node.code}</code></pre>
              {error ? <p className="d2-error mt-2 text-xs">{error}</p> : null}
            </div>
          ) : (
            <div className="d2-render" style={previewStyle}>
              {svgMarkup ? (
                <div className="d2-svg" dangerouslySetInnerHTML={{ __html: svgMarkup }} />
              ) : (
                <div className="flex items-center justify-center px-4 py-10" style={{ color: token.colorTextSecondary, gap: 8 }}>
                  <SyncOutlined spin />
                  <span className="text-sm">{canRenderPreview ? t('chat.renderingChart') : t('chat.chartAboutToRender')}</span>
                </div>
              )}
              {error ? <p className="d2-error px-4 pb-3 text-xs">{error}</p> : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChatD2Node(props: NodeComponentProps<ChatD2CodeBlockNode>) {
  const { node, ctx } = props;
  return <ChatD2BlockNode node={node} isDark={ctx?.isDark} />;
}

// ── Inline tool-call node (renders inside markdown content flow) ──────

const toolCallIcons: Record<string, React.ReactNode> = {
  bash: <Code size={14} />,
  write: <FileCode size={14} />,
  read: <FileText size={14} />,
  edit: <FileCode size={14} />,
  glob: <FileType size={14} />,
  grep: <FileText size={14} />,
  ls: <FileType size={14} />,
};

function getInlineToolIcon(toolName: string): React.ReactNode {
  const lower = toolName.toLowerCase();
  for (const [key, icon] of Object.entries(toolCallIcons)) {
    if (lower.includes(key)) return icon;
  }
  return <Zap size={14} />;
}

const toolCallStatusColors: Record<string, string> = {
  queued: '#faad14',
  running: '#1890ff',
  success: '#52c41a',
  failed: '#ff4d4f',
  cancelled: '#8c8c8c',
};

function ToolCallNode(props: NodeComponentProps<{
  type: 'tool-call';
  content: string;
  attrs?: CustomNodeAttrs;
}>) {
  const { node } = props;
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const toolCalls = useAgentStore((s) => s.toolCalls);
  const [expanded, setExpanded] = useState(false);

  const execId = getCustomAttr(node.attrs, 'id') ?? '';
  const toolName = getCustomAttr(node.attrs, 'name') ?? '';
  const summary = String(node.content ?? '');

  const tc = toolCalls[execId];
  const status = tc?.executionStatus ?? 'success';
  const statusColor = toolCallStatusColors[status] || token.colorTextSecondary;
  const isLoading = status === 'queued' || status === 'running';
  const hasDetails = tc && (tc.input || tc.output);

  return (
    <div style={{ margin: '4px 0' }}>
      <div
        onClick={() => hasDetails && setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          borderRadius: token.borderRadius,
          backgroundColor: token.colorFillQuaternary,
          border: `1px solid ${token.colorBorderSecondary}`,
          fontSize: 13,
          lineHeight: '20px',
          fontFamily: 'monospace',
          cursor: hasDetails ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        <span style={{ color: statusColor, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {getInlineToolIcon(toolName)}
        </span>
        <span style={{ fontWeight: 500, flexShrink: 0 }}>{toolName}</span>
        {summary && (
          <>
            <span style={{ color: token.colorTextQuaternary }}>›</span>
            <Typography.Text
              type="secondary"
              ellipsis
              style={{ fontSize: 12, flex: 1, minWidth: 0 }}
            >
              {summary}
            </Typography.Text>
          </>
        )}
        {isLoading ? (
          <SyncOutlined style={{ fontSize: 12, color: statusColor }} spin />
        ) : (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: statusColor,
              flexShrink: 0,
            }}
          />
        )}
        {hasDetails && (
          <span style={{ color: token.colorTextSecondary, display: 'flex', alignItems: 'center', flexShrink: 0, transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
            <ChevronDown size={14} />
          </span>
        )}
      </div>
      {expanded && hasDetails && (
        <div
          style={{
            margin: '2px 0 0',
            padding: '6px 10px',
            borderRadius: token.borderRadius,
            backgroundColor: token.colorFillQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderTop: 'none',
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {tc.input && Object.keys(tc.input).length > 0 && (
            <details style={{ margin: 0 }}>
              <summary style={{ fontSize: 12, color: token.colorTextSecondary, cursor: 'pointer', userSelect: 'none' }}>
                {t('chat.inspector.toolInput', '输入参数')}
              </summary>
              <pre
                style={{
                  margin: '4px 0 0',
                  padding: 8,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  backgroundColor: token.colorBgTextHover,
                  borderRadius: token.borderRadius,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  maxHeight: 200,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify(tc.input, null, 2)}
              </pre>
            </details>
          )}
          {tc.output && (
            <details style={{ margin: 0 }}>
              <summary style={{ fontSize: 12, color: token.colorTextSecondary, cursor: 'pointer', userSelect: 'none' }}>
                {t('chat.inspector.toolOutput', '执行结果')}
              </summary>
              <pre
                style={{
                  margin: '4px 0 0',
                  padding: 8,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  backgroundColor: token.colorBgTextHover,
                  borderRadius: token.borderRadius,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  maxHeight: 200,
                  overflow: 'auto',
                  color: tc.isError ? token.colorError : undefined,
                }}
              >
                {tc.output}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

setCustomComponents('chat', { think: ThinkNode, 'web-search': WebSearchNode, 'knowledge-retrieval': KnowledgeRetrievalNode, 'memory-retrieval': MemoryRetrievalNode, 'tool-call': ToolCallNode, d2: ChatD2Node, vmr_container: McpContainerNode, image: ChatImageNode, img: ChatImageNode });

const AssistantMarkdown = React.memo(function AssistantMarkdown({
  content,
  nodes,
  isDarkMode,
  isStreaming,
  codeBlockDarkTheme,
  codeBlockLightTheme,
  codeBlockThemes,
  codeFontFamily,
  displayPrefix,
}: {
  content: string;
  nodes?: ChatMarkdownNode[];
  isDarkMode: boolean;
  isStreaming: boolean;
  codeBlockDarkTheme: string;
  codeBlockLightTheme: string;
  codeBlockThemes: string[];
  codeFontFamily?: string;
  displayPrefix?: string;
}) {
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const codeBlockProps = useMemo(
    () => getChatCodeBlockProps(codeBlockDarkTheme, codeBlockLightTheme),
    [codeBlockDarkTheme, codeBlockLightTheme],
  );
  const codeBlockMonacoOptions = useMemo(
    () => codeFontFamily ? { fontFamily: codeFontFamily } : undefined,
    [codeFontFamily],
  );
  const singleD2Node = useMemo(() => getSingleD2CodeBlockNode(nodes), [nodes]);
  const hasDeferredHeavyNodes = useMemo(
    () => !isStreaming && (containsDeferredHeavyNode(nodes) || content.includes('```')),
    [content, nodes, isStreaming],
  );
  const [readyToRenderHeavyNodes, setReadyToRenderHeavyNodes] = useState(!hasDeferredHeavyNodes);
  const rendererKey = `${isDarkMode ? 'dark' : 'light'}:${codeBlockDarkTheme}:${codeBlockLightTheme}`;
  const contentWithoutExplicitDisplay = useMemo(() => (
    displayPrefix
      ? stripLeadingAqbotDisplayTags(content, ['knowledge-retrieval', 'memory-retrieval'])
      : content
  ), [content, displayPrefix]);
  const displaySplit = useMemo(() => {
    if (nodes) return { prefix: displayPrefix ?? '', body: content };
    const split = splitLeadingAqbotDisplayContent(contentWithoutExplicitDisplay);
    return {
      prefix: `${split.prefix}${displayPrefix ?? ''}`,
      body: split.body,
    };
  }, [content, contentWithoutExplicitDisplay, displayPrefix, nodes]);
  const displayPrefixNodes = useMemo(() => (
    displaySplit.prefix
      ? parseChatMarkdown(displaySplit.prefix)
      : undefined
  ), [displaySplit.prefix]);
  const rendererContent = displaySplit.prefix ? displaySplit.body : content;

  useEffect(() => {
    if (!hasDeferredHeavyNodes) {
      setReadyToRenderHeavyNodes(true);
      return;
    }

    setReadyToRenderHeavyNodes(false);
    const element = containerRef.current;
    if (!element || typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      setReadyToRenderHeavyNodes(true);
      return;
    }

    let frameId = 0;
    let timeoutId: number | null = null;
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      frameId = window.requestAnimationFrame(() => {
        if (typeof win.requestIdleCallback === 'function') {
          timeoutId = win.requestIdleCallback(() => setReadyToRenderHeavyNodes(true), { timeout: 250 });
          return;
        }
        timeoutId = window.setTimeout(() => setReadyToRenderHeavyNodes(true), 0);
      });
    }, { rootMargin: '160px 0px' });

    observer.observe(element);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frameId);
      if (timeoutId !== null) {
        if (typeof win.cancelIdleCallback === 'function') {
          win.cancelIdleCallback(timeoutId);
        } else {
          window.clearTimeout(timeoutId);
        }
      }
    };
  }, [content, hasDeferredHeavyNodes]);

  if (singleD2Node) {
    return (
      <ChatD2BlockNode
        key={`d2:${rendererKey}`}
        node={singleD2Node}
        isDark={isDarkMode}
      />
    );
  }

  if (hasDeferredHeavyNodes && !readyToRenderHeavyNodes) {
    return (
      <div className="aqbot-chat-markdown">
        <div
          ref={containerRef}
          className="my-4 rounded-lg border"
          style={{
            borderColor: token.colorBorderSecondary,
            background: isDarkMode ? token.colorBgContainer : token.colorBgElevated,
          }}
        >
          <div
            className="flex items-center justify-center px-4 py-10"
            style={{ color: token.colorTextSecondary, gap: 8 }}
          >
            <SyncOutlined spin />
            <span className="text-sm">{t('chat.loadingRenderContent')}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="aqbot-chat-markdown">
      {nodes ? (
        <NodeRenderer
          key={rendererKey}
          nodes={nodes}
          isDark={isDarkMode}
          customId="chat"
          customHtmlTags={CHAT_CUSTOM_HTML_TAGS}
          final={!isStreaming}
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
      ) : (
        <>
          {displayPrefixNodes && (
            <NodeRenderer
              key={`${rendererKey}:display-prefix`}
              nodes={displayPrefixNodes}
              isDark={isDarkMode}
              customId="chat"
              customHtmlTags={CHAT_CUSTOM_HTML_TAGS}
              final
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
          )}
          {rendererContent && (
            <NodeRenderer
              key={rendererKey}
              content={rendererContent}
              isDark={isDarkMode}
              customId="chat"
              customHtmlTags={CHAT_CUSTOM_HTML_TAGS}
              final={!isStreaming}
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
          )}
        </>
      )}
    </div>
  );
}, (prev, next) => (
  prev.content === next.content
  && prev.nodes === next.nodes
  && prev.isDarkMode === next.isDarkMode
  && prev.isStreaming === next.isStreaming
  && prev.codeBlockDarkTheme === next.codeBlockDarkTheme
  && prev.codeBlockLightTheme === next.codeBlockLightTheme
  && prev.codeBlockThemes === next.codeBlockThemes
  && prev.codeFontFamily === next.codeFontFamily
  && prev.displayPrefix === next.displayPrefix
));

// ── Version pagination component for multi-version AI replies ──────────

function VersionPagination({
  msg,
  conversationId,
  allVersions,
}: {
  msg: Message;
  conversationId: string;
  allVersions: Message[];
}) {
  const { token } = theme.useToken();
  const switchMessageVersion = useConversationStore((s) => s.switchMessageVersion);

  // Scope to current model's versions
  const currentModelId = msg.model_id;
  const modelVersions = allVersions.filter((v) => v.model_id === currentModelId);

  if (modelVersions.length <= 1) return null;

  const sorted = [...modelVersions].sort((a, b) => a.version_index - b.version_index);
  const currentIdx = sorted.findIndex((v) => v.id === msg.id);
  const current = currentIdx >= 0 ? currentIdx : sorted.findIndex((v) => v.is_active);

  const handlePrev = () => {
    if (current > 0 && msg.parent_message_id) {
      switchMessageVersion(conversationId, msg.parent_message_id, sorted[current - 1].id);
    }
  };
  const handleNext = () => {
    if (current < sorted.length - 1 && msg.parent_message_id) {
      switchMessageVersion(conversationId, msg.parent_message_id, sorted[current + 1].id);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginRight: 8 }}>
      <Button
        type="text"
        size="small"
        icon={<ChevronLeft size={14} />}
        disabled={current <= 0}
        onClick={handlePrev}
        style={{ minWidth: 20, padding: '0 2px' }}
      />
      <Typography.Text style={{ fontSize: 11, color: token.colorTextSecondary }}>
        {current + 1}/{sorted.length}
      </Typography.Text>
      <Button
        type="text"
        size="small"
        icon={<ChevronRight size={14} />}
        disabled={current >= sorted.length - 1}
        onClick={handleNext}
        style={{ minWidth: 20, padding: '0 2px' }}
      />
    </span>
  );
}

function ModelTags({
  msg,
  conversationId,
  allVersions,
  getModelDisplayInfo,
}: {
  msg: Message;
  conversationId: string;
  allVersions: Message[];
  getModelDisplayInfo: (modelId?: string | null, providerId?: string | null) => { modelName: string; providerName: string };
}) {
  const { token } = theme.useToken();
  const switchMessageVersion = useConversationStore((s) => s.switchMessageVersion);
  const pendingCompanionModels = useConversationStore((s) => s.pendingCompanionModels);
  const multiModelParentId = useConversationStore((s) => s.multiModelParentId);
  const multiModelDoneMessageIds = useConversationStore((s) => s.multiModelDoneMessageIds);

  // Only show pending/streaming indicators for the specific multi-model target message
  const isMultiModelTarget = msg.parent_message_id === multiModelParentId;

  const modelGroups = useMemo(() => {
    const groups = new Map<string, Message[]>();
    for (const v of allVersions) {
      const key = v.model_id ?? '__unknown__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(v);
    }
    return groups;
  }, [allVersions]);

  // Pending companions that haven't generated a version yet
  const pendingModels = useMemo(() => {
    if (!isMultiModelTarget || !pendingCompanionModels.length) return [];
    return pendingCompanionModels.filter((cm) => !modelGroups.has(cm.modelId));
  }, [isMultiModelTarget, pendingCompanionModels, modelGroups]);

  // Check if a model is currently streaming (has a version but not yet completed)
  const streamingModelIds = useMemo(() => {
    const ids = new Set<string>();
    if (!isMultiModelTarget) return ids;
    for (const cm of pendingCompanionModels) {
      if (modelGroups.has(cm.modelId)) {
        // Check if this model's version has completed (per-model tracking)
        const versions = modelGroups.get(cm.modelId)!;
        const isDone = versions.some((v) => multiModelDoneMessageIds.includes(v.id));
        if (!isDone) ids.add(cm.modelId);
      }
    }
    return ids;
  }, [isMultiModelTarget, pendingCompanionModels, modelGroups, multiModelDoneMessageIds]);

  if (modelGroups.size <= 1 && pendingModels.length === 0) return null;

  const currentModelId = msg.model_id ?? '__unknown__';

  const handleTagClick = (modelId: string) => {
    if (modelId === currentModelId || !msg.parent_message_id) return;
    const versions = modelGroups.get(modelId);
    if (!versions || versions.length === 0) return;
    const sorted = [...versions].sort((a, b) => b.version_index - a.version_index);
    switchMessageVersion(conversationId, msg.parent_message_id, sorted[0].id);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {Array.from(modelGroups.keys()).map((modelId) => {
        const isActive = modelId === currentModelId;
        const isStreaming = streamingModelIds.has(modelId);
        const { modelName } = getModelDisplayInfo(modelId, modelGroups.get(modelId)?.[0]?.provider_id);
        return (
          <Tooltip key={modelId} title={modelName} mouseEnterDelay={0.3}>
            <div
              onClick={() => handleTagClick(modelId)}
              className={isStreaming ? 'model-tag-streaming' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: '50%',
                border: `1.5px solid ${isActive ? token.colorPrimary : 'transparent'}`,
                cursor: isActive ? 'default' : 'pointer',
                transition: 'border-color 0.2s',
                flexShrink: 0,
              }}
            >
              <ModelIcon model={modelId} size={20} type="avatar" />
            </div>
          </Tooltip>
        );
      })}
      {/* Pending companion models waiting to stream */}
      {pendingModels.map((cm) => {
        const { modelName } = getModelDisplayInfo(cm.modelId, cm.providerId);
        return (
          <Tooltip key={`pending-${cm.modelId}`} title={`${modelName} (waiting...)`} mouseEnterDelay={0.3}>
            <div
              className="model-tag-pending"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: '50%',
                border: `1.5px dashed ${token.colorTextQuaternary}`,
                opacity: 0.5,
                flexShrink: 0,
              }}
            >
              <ModelIcon model={cm.modelId} size={20} type="avatar" />
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

// 3-button delete popover for last AI version
function DeleteLastVersionPopover({
  msg,
  conversationId,
  deleteMessage,
  deleteMessageGroup,
  messageApi,
  token,
}: {
  msg: Message;
  conversationId: string;
  deleteMessage: (messageId: string) => Promise<void>;
  deleteMessageGroup: (convId: string, parentMsgId: string) => Promise<void>;
  messageApi: ReturnType<typeof App.useApp>['message'];
  token: ReturnType<typeof theme.useToken>['token'];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const handleDeleteThisOnly = async () => {
    setOpen(false);
    try {
      await deleteMessage(msg.id);
    } catch (e) {
      messageApi.error(String(e));
    }
  };

  const handleDeleteAll = async () => {
    setOpen(false);
    try {
      if (msg.parent_message_id) {
        await deleteMessageGroup(conversationId, msg.parent_message_id);
      } else if (msg.id.startsWith('temp-')) {
        // No parent link (e.g. error before backend persisted) — remove locally
        useConversationStore.setState((s) => ({
          messages: s.messages.filter((m) => m.id !== msg.id),
        }));
      }
    } catch (e) {
      messageApi.error(String(e));
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="top"
      content={
        <div style={{ maxWidth: 280 }}>
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <AlertCircle size={16} style={{ color: token.colorWarning, marginTop: 2, flexShrink: 0 }} />
            <span>{t('chat.deleteLastVersionHint')}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button size="small" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="small" onClick={handleDeleteThisOnly}>
              {t('chat.deleteThisOnly')}
            </Button>
            <Button size="small" danger type="primary" onClick={handleDeleteAll}>
              {t('chat.deleteAll')}
            </Button>
          </div>
        </div>
      }
    >
      <Tooltip title={t('chat.delete')}>
        <span className="aqbot-action-item" style={{ color: token.colorError }}>
          <Trash2 size={14} />
        </span>
      </Tooltip>
    </Popover>
  );
}

function AssistantFooter({
  msg,
  conversationId,
  assistantCopyText,
  getModelDisplayInfo,
  onEditMessage,
  isStreaming = false,
  displayMode,
  onDisplayModeChange,
  onMultiModelDetected,
}: {
  msg: Message;
  conversationId: string;
  assistantCopyText: string;
  getModelDisplayInfo: (modelId?: string | null, providerId?: string | null) => { modelName: string; providerName: string };
  onEditMessage: (messageId: string, content: string, role: 'user' | 'assistant') => void;
  isStreaming?: boolean;
  displayMode?: MultiModelDisplayMode;
  onDisplayModeChange?: (parentMsgId: string, mode: MultiModelDisplayMode) => void;
  onMultiModelDetected?: (parentMsgId: string, versions: Message[]) => void;
}) {
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const [allVersions, setAllVersions] = useState<Message[]>([]);
  const listMessageVersions = useConversationStore((s) => s.listMessageVersions);
  const hydrateMessageVersions = useConversationStore((s) => s.hydrateMessageVersions);
  const regenerateMessage = useConversationStore((s) => s.regenerateMessage);
  const regenerateWithModel = useConversationStore((s) => s.regenerateWithModel);
  const deleteMessageGroup = useConversationStore((s) => s.deleteMessageGroup);
  const deleteMessage = useConversationStore((s) => s.deleteMessage);
  const branchConversation = useConversationStore((s) => s.branchConversation);
  const { copy: copyAssistant, isCopied: assistantCopied } = useCopyToClipboard();
  // Branch modal state
  const [branchModalOpen, setBranchModalOpen] = useState(false);
  const [branchAsChild, setBranchAsChild] = useState(false);
  const [branchTitle, setBranchTitle] = useState('');
  const conversations = useConversationStore((s) => s.conversations);
  const currentConvTitle = conversations.find((c) => c.id === conversationId)?.title ?? '';
  // Track message count to re-fetch versions when companion messages appear
  const messagesLength = useConversationStore((s) => s.messages.length);
  const storeMessages = useConversationStore((s) => s.messages);

  useEffect(() => {
    if (msg.parent_message_id && conversationId) {
      listMessageVersions(conversationId, msg.parent_message_id).then((v) => {
        if (v) {
          setAllVersions(v);
          if (v.length > 0) {
            hydrateMessageVersions(msg.parent_message_id!, v);
          }
        }
      });
    }
  }, [msg.parent_message_id, msg.id, conversationId, listMessageVersions, hydrateMessageVersions, messagesLength]);

  // Merge DB-fetched versions with in-store companion messages for real-time visibility
  const mergedVersions = useMemo(() => {
    if (!msg.parent_message_id) return allVersions;
    const dbIds = new Set(allVersions.map((v) => v.id));
    const extra = storeMessages.filter(
      (m) => m.parent_message_id === msg.parent_message_id && m.role === 'assistant' && !dbIds.has(m.id) && m.model_id,
    );
    return extra.length > 0 ? [...allVersions, ...extra] : allVersions;
  }, [allVersions, storeMessages, msg.parent_message_id]);

  // Check if this message has multiple model versions
  const hasMultiModels = useMemo(() => hasMultipleModelVersions(mergedVersions), [mergedVersions]);

  // Report the latest version snapshot to parent so cached multi-model state
  // can be updated or cleared after deletes/switches.
  useEffect(() => {
    if (msg.parent_message_id && onMultiModelDetected) {
      onMultiModelDetected(msg.parent_message_id, mergedVersions);
    }
  }, [msg.parent_message_id, mergedVersions, onMultiModelDetected]);

  // Current message's model for ModelSelector highlight
  const currentModelOverride = useMemo(() => {
    if (msg.provider_id && msg.model_id) {
      return { providerId: msg.provider_id, modelId: msg.model_id };
    }
    return null;
  }, [msg.provider_id, msg.model_id]);

  const handleModelSelect = useCallback(async (providerId: string, modelId: string) => {
    try {
      if (providerId === msg.provider_id && modelId === msg.model_id) {
        // Same model → regular regenerate
        await regenerateMessage(msg.id);
      } else {
        // Different model → generate with new model
        await regenerateWithModel(msg.id, providerId, modelId);
      }
    } catch (e) {
      messageApi.error(String(e));
    }
  }, [msg.id, msg.provider_id, msg.model_id, regenerateMessage, regenerateWithModel, messageApi]);
  const totalTokens = (msg.prompt_tokens ?? 0) + (msg.completion_tokens ?? 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {!isStreaming && (msg.prompt_tokens != null || msg.completion_tokens != null || msg.tokens_per_second != null || msg.first_token_latency_ms != null) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: token.colorTextDescription, lineHeight: '16px', marginTop: -6, marginBottom: 4, flexWrap: 'wrap' }}>
          {msg.prompt_tokens != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <ArrowUp size={10} />
              {formatTokenCount(msg.prompt_tokens)} tokens
            </span>
          )}
          {msg.completion_tokens != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <ArrowDown size={10} />
              {formatTokenCount(msg.completion_tokens)} tokens
            </span>
          )}
          {totalTokens > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <Coins size={10} />
              {formatTokenCount(totalTokens)} tokens
            </span>
          )}
          {msg.tokens_per_second != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <Zap size={10} />
              {formatSpeed(msg.tokens_per_second)}
            </span>
          )}
          {msg.first_token_latency_ms != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <TextCursorInput size={10} />
              {formatDuration(msg.first_token_latency_ms)}
            </span>
          )}
        </div>
      )}
      {!isStreaming && (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <VersionPagination msg={msg} conversationId={conversationId} allVersions={mergedVersions} />
          <Actions
          items={[
            {
              key: 'copy',
              icon: assistantCopied ? <Check size={14} style={{ color: token.colorSuccess }} /> : <Copy size={14} />,
              label: t('chat.copy'),
              onItemClick: () => {
                void copyAssistant(assistantCopyText).then(ok => {
                  if (ok) messageApi.success(t('chat.copied'));
                });
              },
            },
            {
              key: 'regenerate',
              icon: <RotateCcw size={14} />,
              label: t('chat.regenerate'),
              onItemClick: async () => {
                try {
                  await regenerateMessage(msg.id);
                } catch (e) {
                  messageApi.error(String(e));
                }
              },
            },
            ...(msg.role === 'assistant' ? [{
              key: 'edit',
              icon: <Pencil size={14} />,
              label: t('chat.editMessage'),
              onItemClick: () => {
                onEditMessage(msg.id, msg.content, 'assistant');
              },
            }] : []),
            {
              key: 'model',
              actionRender: () => (
                <ModelSelector
                  onSelect={handleModelSelect}
                  overrideCurrentModel={currentModelOverride}
                >
                  <Tooltip title={t('chat.switchModel')}>
                    <span className="aqbot-action-item" style={{ color: token.colorTextSecondary }}>
                      <ArrowLeftRight size={14} />
                    </span>
                  </Tooltip>
                </ModelSelector>
              ),
            },
            {
              key: 'branch',
              actionRender: () => (
                <Dropdown
                  menu={{
                    items: [
                      {
                        key: 'independent',
                        label: t('chat.branchIndependent'),
                        onClick: () => {
                          setBranchAsChild(false);
                          setBranchTitle(currentConvTitle);
                          setBranchModalOpen(true);
                        },
                      },
                      {
                        key: 'child',
                        label: t('chat.branchChild'),
                        onClick: () => {
                          setBranchAsChild(true);
                          setBranchTitle(currentConvTitle);
                          setBranchModalOpen(true);
                        },
                      },
                    ],
                  }}
                  trigger={['click']}
                  placement="bottom"
                >
                  <Tooltip title={t('chat.branchConversation')}>
                    <span className="aqbot-action-item" style={{ color: token.colorTextSecondary }}>
                      <GitBranch size={14} />
                    </span>
                  </Tooltip>
                </Dropdown>
              ),
            },
            {
              key: 'delete',
              actionRender: () => {
                const isLastVersion = mergedVersions.filter((v) => v.id !== msg.id).length === 0;

                if (isLastVersion) {
                  // Last version — Popover with 3 buttons
                  return (
                    <DeleteLastVersionPopover
                      msg={msg}
                      conversationId={conversationId}
                      deleteMessage={deleteMessage}
                      deleteMessageGroup={deleteMessageGroup}
                      messageApi={messageApi}
                      token={token}
                    />
                  );
                }

                // Multiple versions — standard Popconfirm
                return (
                  <Popconfirm
                    title={t('chat.confirmDeleteVersion')}
                    onConfirm={async () => {
                      try {
                        await deleteMessage(msg.id);
                      } catch (e) {
                        messageApi.error(String(e));
                      }
                    }}
                    okText={t('common.confirm')}
                    cancelText={t('common.cancel')}
                  >
                    <Tooltip title={t('chat.delete')}>
                      <span className="aqbot-action-item" style={{ color: token.colorError }}>
                        <Trash2 size={14} />
                      </span>
                    </Tooltip>
                  </Popconfirm>
                );
              },
            },
          ]}
        />
      </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        {hasMultiModels && displayMode && onDisplayModeChange && msg.parent_message_id && (
          <LayoutSwitcher
            currentMode={displayMode}
            onModeChange={(mode) => onDisplayModeChange(msg.parent_message_id!, mode)}
          />
        )}
        <ModelTags msg={msg} conversationId={conversationId} allVersions={mergedVersions} getModelDisplayInfo={getModelDisplayInfo} />
      </div>
      <Modal
        open={branchModalOpen}
        title={t('chat.branchConversation')}
        onCancel={() => setBranchModalOpen(false)}
        onOk={async () => {
          try {
            const title = branchTitle.trim() || currentConvTitle;
            await branchConversation(conversationId, msg.id, branchAsChild, title);
            messageApi.success(t('chat.branchCreated'));
            setBranchModalOpen(false);
          } catch (e) {
            messageApi.error(String(e));
          }
        }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        width={400}
        destroyOnClose
      >
        <Input
          value={branchTitle}
          onChange={(e) => setBranchTitle(e.target.value)}
          placeholder={t('chat.branchTitlePlaceholder')}
          autoFocus
          onPressEnter={async () => {
            try {
              const title = branchTitle.trim() || currentConvTitle;
              await branchConversation(conversationId, msg.id, branchAsChild, title);
              messageApi.success(t('chat.branchCreated'));
              setBranchModalOpen(false);
            } catch (e) {
              messageApi.error(String(e));
            }
          }}
        />
      </Modal>
    </div>
  );
}


// ── Export helpers ──────────────────────────────────────────────────────

import { copyTranscript, exportAsPNG, exportAsMarkdown, exportAsJSON, exportAsText } from '@/lib/exportChat';

// ── Stats Popover ──────────────────────────────────────────────────────

function StatsPopoverContent({ stats, t, token }: {
  stats: ConversationStats | null;
  t: (key: string) => string;
  token: Record<string, any>;
}) {
  if (!stats) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 40px' }}>
        <Spin size="small" />
      </div>
    );
  }

  const items: Array<{
    icon: React.ReactNode;
    label: string;
    value: string;
    sub?: Array<{ icon: React.ReactNode; label: string; value: string }>;
  }> = [
    {
      icon: <MessageSquare size={14} />,
      label: t('chat.stats.totalMessages'),
      value: stats.total_messages.toLocaleString(),
      sub: [
        { icon: <User size={12} />, label: t('chat.stats.userMessages'), value: stats.total_user_messages.toLocaleString() },
        { icon: <Bot size={12} />, label: t('chat.stats.assistantMessages'), value: stats.total_assistant_messages.toLocaleString() },
      ],
    },
    {
      icon: <Coins size={14} />,
      label: t('chat.stats.totalTokens'),
      value: formatTokenCount(stats.total_tokens),
      sub: [
        { icon: <ArrowUpRight size={12} />, label: t('chat.stats.inputTokens'), value: formatTokenCount(stats.total_prompt_tokens) },
        { icon: <ArrowDownRight size={12} />, label: t('chat.stats.outputTokens'), value: formatTokenCount(stats.total_completion_tokens) },
      ],
    },
    ...(stats.avg_first_token_latency_ms != null ? [{
      icon: <Zap size={14} />,
      label: t('chat.stats.avgFirstToken'),
      value: formatDuration(stats.avg_first_token_latency_ms),
    }] : []),
    ...(stats.avg_response_time_ms != null ? [{
      icon: <Clock size={14} />,
      label: t('chat.stats.avgResponseTime'),
      value: formatDuration(stats.avg_response_time_ms),
    }] : []),
    ...(stats.avg_tokens_per_second != null ? [{
      icon: <Timer size={14} />,
      label: t('chat.stats.avgSpeed'),
      value: formatSpeed(stats.avg_tokens_per_second),
    }] : []),
  ];

  return (
    <div style={{ minWidth: 220, maxWidth: 280 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ChartNoAxesColumn size={14} />
        {t('chat.stats.title')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item, i) => (
          <div key={i}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: token.colorTextSecondary }}>
                {item.icon}
                {item.label}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {item.value}
              </span>
            </div>
            {item.sub && (
              <div style={{ marginLeft: 20, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {item.sub.map((s, j) => (
                  <div key={j} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: token.colorTextDescription }}>
                      {s.icon}
                      {s.label}
                    </span>
                    <span style={{ fontSize: 12, color: token.colorTextSecondary, fontVariantNumeric: 'tabular-nums' }}>
                      {s.value}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {i < items.length - 1 && (
              <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, marginTop: 10 }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────

export function ChatView() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message: messageApi } = App.useApp();

  // ── Store selectors ────────────────────────────────────────────────
  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const messages = useConversationStore((s) => s.messages);
  const ragDisplayByMessageId = useConversationStore((s) => s.ragDisplayByMessageId);
  const loading = useConversationStore((s) => s.loading);
  const loadingOlder = useConversationStore((s) => s.loadingOlder);
  const hasOlderMessages = useConversationStore((s) => s.hasOlderMessages);
  const streaming = useConversationStore((s) => s.streaming);
  const compressing = useConversationStore((s) => s.compressing);
  const streamingMessageId = useConversationStore((s) => s.streamingMessageId);
  const multiModelParentId = useConversationStore((s) => s.multiModelParentId);
  const multiModelDoneMessageIds = useConversationStore((s) => s.multiModelDoneMessageIds);
  const thinkingActiveMessageIds = useConversationStore((s) => s.thinkingActiveMessageIds);
  const storeError = useConversationStore((s) => s.error);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const titleGeneratingConversationId = useConversationStore((s) => s.titleGeneratingConversationId);
  const regenerateTitle = useConversationStore((s) => s.regenerateTitle);
  const loadOlderMessages = useConversationStore((s) => s.loadOlderMessages);
  const regenerateMessage = useConversationStore((s) => s.regenerateMessage);
  const deleteMessage = useConversationStore((s) => s.deleteMessage);
  const deleteMessageGroup = useConversationStore((s) => s.deleteMessageGroup);
  const switchMessageVersion = useConversationStore((s) => s.switchMessageVersion);
  const updateMessageContent = useConversationStore((s) => s.updateMessageContent);
  const removeContextClear = useConversationStore((s) => s.removeContextClear);
  const getCompressionSummary = useConversationStore((s) => s.getCompressionSummary);
  const deleteCompression = useConversationStore((s) => s.deleteCompression);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [summaryModalText, setSummaryModalText] = useState('');
  const [previewPayload, setPreviewPayload] = useState<CodeBlockPreviewPayload | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [mermaidPreviewSvg, setMermaidPreviewSvg] = useState<string | null>(null);
  const [mermaidPreviewOpen, setMermaidPreviewOpen] = useState(false);
  const createConversation = useConversationStore((s) => s.createConversation);
  const providers = useProviderStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const bubbleStyle = settings.bubble_style;
  const profile = useUserProfileStore((s) => s.profile);
  const resolvedAvatarSrc = useResolvedAvatarSrc(profile.avatarType, profile.avatarValue);
  const isDarkMode = useResolvedDarkMode(settings.theme_mode);
  const { copy: copyMessage, isCopiedFor: isUserMsgCopied } = useCopyToClipboard();
  const { darkTheme: codeBlockDarkTheme, lightTheme: codeBlockLightTheme, themes: codeBlockThemes } = useMemo(
    () => getChatCodeThemes(settings.code_theme, settings.code_theme_light),
    [settings.code_theme, settings.code_theme_light],
  );
  const bubbleListThemeKey = `bubble-list:${isDarkMode ? 'dark' : 'light'}:${settings.code_theme ?? ''}:${settings.code_theme_light ?? ''}`;

  // Pre-load Shiki themes into the singleton highlighter when theme settings change
  useEffect(() => {
    console.log('[AQBot Theme Debug] themes changed:', { codeBlockDarkTheme, codeBlockLightTheme, codeBlockThemes, isDarkMode });
    if (codeBlockThemes.length > 0) {
      registerHighlight({ themes: codeBlockThemes as any }).catch((err) => {
        console.error('[AQBot Theme Debug] registerHighlight failed:', err);
      });
    }
  }, [codeBlockThemes, codeBlockDarkTheme, codeBlockLightTheme, isDarkMode]);

  // Register module-level preview handler for code blocks
  useEffect(() => {
    _codeBlockPreviewHandler = (payload: CodeBlockPreviewPayload) => {
      setPreviewPayload(payload);
      setPreviewModalOpen(true);
    };
    return () => { _codeBlockPreviewHandler = null; };
  }, []);

  // Register module-level preview handler for mermaid
  useEffect(() => {
    _mermaidOpenModalHandler = (svgString: string | null) => {
      setMermaidPreviewSvg(svgString);
      setMermaidPreviewOpen(true);
    };
    return () => { _mermaidOpenModalHandler = null; };
  }, []);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const isTitleGenerating = activeConversationId != null && titleGeneratingConversationId === activeConversationId;

  const renderConvIconForChat = useCallback((size: number, modelId?: string | null) => {
    if (!activeConversation) return <Avatar icon={<Bot size={16} />} style={{ background: token.colorPrimary }} size={size} />;
    const customIcon = getConvIcon(activeConversation.id);
    if (customIcon) {
      if (customIcon.type === 'emoji') {
        return <Avatar size={size} style={{ fontSize: Math.round(size * 0.5), backgroundColor: token.colorPrimaryBg }}>{customIcon.value}</Avatar>;
      }
      return <Avatar size={size} src={customIcon.value} />;
    }
    const mid = modelId ?? activeConversation.model_id;
    if (mid) {
      return <ModelIcon model={mid} size={size} type="avatar" />;
    }
    return <Avatar icon={<Bot size={16} />} style={{ background: token.colorPrimary }} size={size} />;
  }, [activeConversation, token.colorPrimary, token.colorPrimaryBg]);

  // ── User avatar helper (mirrors Sidebar.tsx pattern) ───────────────
  const renderUserAvatar = useCallback(() => {
    const size = 32;
    if (profile.avatarType === 'emoji' && profile.avatarValue) {
      return (
        <div
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            backgroundColor: token.colorFillSecondary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
          }}
        >
          {profile.avatarValue}
        </div>
      );
    }
    if ((profile.avatarType === 'url' || profile.avatarType === 'file') && profile.avatarValue) {
      const src = profile.avatarType === 'file' ? resolvedAvatarSrc : profile.avatarValue;
      return <Avatar size={size} src={src} />;
    }
    return (
      <Avatar size={size} icon={<User size={16} />} style={{ backgroundColor: token.colorPrimary }} />
    );
  }, [profile, token, resolvedAvatarSrc]);
  const userAvatar = useMemo(() => renderUserAvatar(), [renderUserAvatar]);

  // ── Bubble style variant helper ────────────────────────────────────
  const getBubbleVariant = useCallback(
    (isUser: boolean): { variant: 'filled' | 'outlined' | 'shadow' | 'borderless'; style?: React.CSSProperties } => {
      switch (bubbleStyle) {
        case 'compact':
          return { variant: 'borderless' };
        case 'minimal':
          return { variant: 'borderless', style: { padding: '4px 8px' } };
        case 'modern':
        default:
          return { variant: isUser ? 'shadow' : 'outlined' };
      }
    },
    [bubbleStyle],
  );

  // ── Title editing state ────────────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageRole, setEditingMessageRole] = useState<'user' | 'assistant' | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<InputRef>(null);
  const skipTitleSaveRef = useRef(false);

  // ── Stats popover state ─────────────────────────────────────────────
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<ConversationStats | null>(null);
  const handleStatsOpenChange = useCallback(async (open: boolean) => {
    setStatsOpen(open);
    if (open && activeConversationId) {
      setStats(null);
      try {
        const data = await invoke<ConversationStats>('get_conversation_stats', { conversationId: activeConversationId });
        setStats(data);
      } catch {
        setStats(null);
      }
    }
  }, [activeConversationId]);
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const bubbleListRef = useRef<BubbleListRef | null>(null);
  const scrollBoxRef = useRef<HTMLElement | null>(null);
  const scrollContentRef = useRef<HTMLElement | null>(null);
  const pendingScrollConversationIdRef = useRef<string | null>(activeConversationId ?? null);
  const stickToBottomRef = useRef(stickToBottom);
  const scrollLayoutMetricsRef = useRef({ scrollHeight: 0, clientHeight: 0 });
  const lastUserScrollIntentAtRef = useRef(0);
  const contentRendererMessageIdsRef = useRef<Set<string>>(new Set());

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentAtRef.current = Date.now();
  }, []);

  const syncChatScrollRefs = useCallback(() => {
    const { scrollBox, scrollContent } = resolveChatScrollElements(
      messageAreaRef.current,
      (bubbleListRef.current?.scrollBoxNativeElement as HTMLElement | null | undefined) ?? null,
    );

    scrollBoxRef.current = scrollBox;
    scrollContentRef.current = scrollContent;
    return { scrollBox, scrollContent };
  }, []);

  const setStickToBottomState = useCallback((nextStickToBottom: boolean) => {
    stickToBottomRef.current = nextStickToBottom;
    setStickToBottom((prev) => (
      prev === nextStickToBottom ? prev : nextStickToBottom
    ));
  }, []);

  // Keep scrollBoxRef in sync with bubbleListRef
  useEffect(() => {
    syncChatScrollRefs();
  });

  useEffect(() => {
    stickToBottomRef.current = stickToBottom;
  }, [stickToBottom]);

  useEffect(() => {
    let attachedScrollBox: HTMLElement | null = null;
    let frameId = 0;
    const handleUserIntent = () => {
      markUserScrollIntent();
    };

    const detach = () => {
      if (!attachedScrollBox) return;
      attachedScrollBox.removeEventListener('wheel', handleUserIntent);
      attachedScrollBox.removeEventListener('touchstart', handleUserIntent);
      attachedScrollBox.removeEventListener('touchmove', handleUserIntent);
      attachedScrollBox.removeEventListener('pointerdown', handleUserIntent);
      attachedScrollBox = null;
    };

    const attach = () => {
      frameId = 0;
      const { scrollBox } = syncChatScrollRefs();
      if (!scrollBox || scrollBox === attachedScrollBox) return;

      detach();
      attachedScrollBox = scrollBox;
      attachedScrollBox.addEventListener('wheel', handleUserIntent, { passive: true });
      attachedScrollBox.addEventListener('touchstart', handleUserIntent, { passive: true });
      attachedScrollBox.addEventListener('touchmove', handleUserIntent, { passive: true });
      attachedScrollBox.addEventListener('pointerdown', handleUserIntent, { passive: true });
      scrollLayoutMetricsRef.current = {
        scrollHeight: attachedScrollBox.scrollHeight,
        clientHeight: attachedScrollBox.clientHeight,
      };
    };

    const scheduleAttach = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(attach);
    };

    scheduleAttach();
    const observerRoot = messageAreaRef.current ?? document.body;
    const observer = new MutationObserver(scheduleAttach);
    observer.observe(observerRoot, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      detach();
    };
  }, [activeConversationId, bubbleListThemeKey, markUserScrollIntent, messages.length, syncChatScrollRefs]);

  // Scroll callback for ChatMinimap — finds bubble DOM element by message ID
  const minimapScrollTo = useCallback((messageId: string) => {
    // scrollBoxRef may not be populated yet on first load; fall back to DOM query
    let scrollBox = scrollBoxRef.current;
    if (!scrollBox) {
      scrollBox = (bubbleListRef.current?.scrollBoxNativeElement as HTMLElement)
        ?? document.querySelector<HTMLElement>('.ant-bubble-list-scroll-box');
      if (scrollBox) scrollBoxRef.current = scrollBox;
    }
    if (!scrollBox) return;
    const marker = scrollBox.querySelector(`[data-aqbot-msg="${messageId}"]`);
    if (!marker) return;
    // Walk up from marker to find the bubble wrapper (near-child of scrollBox)
    let el: Element = marker;
    for (;;) {
      const parent = el.parentElement;
      if (!parent || parent === scrollBox) break;
      if (parent.parentElement === scrollBox) break;
      el = parent;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [editingTitle]);

  useEffect(() => {
    pendingScrollConversationIdRef.current = activeConversationId ?? null;
    setShowScrollToBottom(false);
    setStickToBottomState(true);
    scrollLayoutMetricsRef.current = { scrollHeight: 0, clientHeight: 0 };
    contentRendererMessageIdsRef.current.clear();
  }, [activeConversationId, setStickToBottomState]);

  useEffect(() => {
    if (!streaming || !streamingMessageId) {
      return;
    }
    contentRendererMessageIdsRef.current.add(streamingMessageId);
  }, [streaming, streamingMessageId]);

  const syncScrollToBottomVisibility = useCallback(() => {
    const { scrollBox: target } = syncChatScrollRefs();
    if (!target) return;
    const nextShowScrollToBottom = shouldShowScrollToBottom(
      target.scrollHeight,
      target.scrollTop,
      target.clientHeight,
      CHAT_SCROLL_IS_REVERSED,
    );
    setShowScrollToBottom((prev) => (prev === nextShowScrollToBottom ? prev : nextShowScrollToBottom));
  }, [syncChatScrollRefs]);

  // Load agent tool history from DB on conversation switch
  useEffect(() => {
    if (activeConversation?.mode === 'agent' && activeConversationId) {
      useAgentStore.getState().loadToolHistory(activeConversationId);
    }
  }, [activeConversationId, activeConversation?.mode]);

  // Show store errors as notifications
  useEffect(() => {
    if (storeError) {
      messageApi.error(storeError);
      useConversationStore.setState({ error: null });
    }
  }, [storeError, messageApi]);

  // ── Agent event listeners ────────────────────────────────────────────
  useEffect(() => {
    const cleanup = setupAgentEventListeners();
    return cleanup;
  }, []);

  const currentAgentStatus = useAgentStore(
    (s) => (activeConversationId ? s.agentStatus[activeConversationId] : undefined),
  );

  const agentToolCalls = useAgentStore((s) => s.toolCalls);
  const agentPendingPermissions = useAgentStore((s) => s.pendingPermissions);
  const agentPendingAskUser = useAgentStore((s) => s.pendingAskUser);

  const handleTitleClick = useCallback(() => {
    if (!activeConversation) return;
    setTitleDraft(activeConversation.title);
    setEditingTitle(true);
  }, [activeConversation]);

  const handleTitleSave = useCallback(async () => {
    if (skipTitleSaveRef.current) {
      skipTitleSaveRef.current = false;
      return;
    }
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (!trimmed || !activeConversation || trimmed === activeConversation.title) return;
    await updateConversation(activeConversation.id, { title: trimmed });
  }, [titleDraft, activeConversation, updateConversation]);

  const handleRegenerateTitle = useCallback(async () => {
    if (!activeConversation || isTitleGenerating) return;
    skipTitleSaveRef.current = true;
    setEditingTitle(false);
    await regenerateTitle(activeConversation.id);
  }, [activeConversation, isTitleGenerating, regenerateTitle]);

  const handleLoadOlderMessages = useCallback(async () => {
    const scrollContainer = bubbleListRef.current?.scrollBoxNativeElement as HTMLDivElement | null | undefined;
    const previousScrollHeight = scrollContainer?.scrollHeight ?? 0;
    const previousScrollTop = scrollContainer?.scrollTop ?? 0;
    await loadOlderMessages();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!scrollContainer) return;
        scrollContainer.scrollTop = getScrollTopAfterPrepend(
          previousScrollTop,
          previousScrollHeight,
          scrollContainer.scrollHeight,
          CHAT_SCROLL_IS_REVERSED,
        );
      });
    });
  }, [loadOlderMessages]);

  const handleBubbleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const currentMetrics = {
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    };
    const hasLayoutChangedSinceLastMeasure = hasMeasuredScrollLayoutChanged(
      scrollLayoutMetricsRef.current,
      currentMetrics,
    );
    scrollLayoutMetricsRef.current = currentMetrics;
    setShowScrollToBottom(
      shouldShowScrollToBottom(
        target.scrollHeight,
        target.scrollTop,
        target.clientHeight,
        CHAT_SCROLL_IS_REVERSED,
      ),
    );
    const keepAutoScroll = shouldKeepAutoScroll(
      target.scrollHeight,
      target.scrollTop,
      target.clientHeight,
      CHAT_SCROLL_IS_REVERSED,
      CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD,
    );
    const hadRecentUserScrollIntent = Date.now() - lastUserScrollIntentAtRef.current < USER_SCROLL_INTENT_GRACE_MS;
    if (shouldIgnoreScrollDepartureFromBottom(
      keepAutoScroll,
      stickToBottomRef.current,
      hadRecentUserScrollIntent,
      hasLayoutChangedSinceLastMeasure,
    )) {
      bubbleListRef.current?.scrollTo({ top: 'bottom', behavior: 'auto' });
      setShowScrollToBottom(false);
      return;
    }
    if (keepAutoScroll !== stickToBottomRef.current) {
      setStickToBottomState(keepAutoScroll);
    }
    if (!hasOlderMessages || loading || loadingOlder) return;
    const distanceToHistoryTop = getDistanceToHistoryTop(
      target.scrollHeight,
      target.scrollTop,
      target.clientHeight,
      CHAT_SCROLL_IS_REVERSED,
    );
    if (distanceToHistoryTop > 24) return;
    void handleLoadOlderMessages();
  }, [handleLoadOlderMessages, hasOlderMessages, loading, loadingOlder, setStickToBottomState]);

  const handleScrollToBottom = useCallback(() => {
    bubbleListRef.current?.scrollTo({ top: 'bottom', behavior: 'smooth' });
    setShowScrollToBottom(false);
    setStickToBottomState(true);
  }, [setStickToBottomState]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;

    let resizeObserver: ResizeObserver | null = null;
    let observedScrollBox: HTMLElement | null = null;
    let observedScrollContent: HTMLElement | null = null;
    let frameId = 0;
    let attachFrameId = 0;

    const handleLayoutResize = () => {
      frameId = 0;
      const { scrollBox: target } = syncChatScrollRefs();
      if (!target) return;

      const nextMetrics = {
        scrollHeight: target.scrollHeight,
        clientHeight: target.clientHeight,
      };
      const previousMetrics = scrollLayoutMetricsRef.current;

      if (!hasScrollLayoutMetricsChanged(previousMetrics, nextMetrics)) {
        return;
      }

      scrollLayoutMetricsRef.current = nextMetrics;

      const hadRecentUserScrollIntent = Date.now() - lastUserScrollIntentAtRef.current < USER_SCROLL_INTENT_GRACE_MS;

      if (shouldStickToBottomOnLayoutChange(
        previousMetrics,
        nextMetrics,
        stickToBottomRef.current,
        hadRecentUserScrollIntent,
      )) {
        bubbleListRef.current?.scrollTo({ top: 'bottom', behavior: 'auto' });
        setShowScrollToBottom(false);
        return;
      }

      syncScrollToBottomVisibility();
    };

    const disconnectResizeObserver = () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      observedScrollBox = null;
      observedScrollContent = null;
    };

    const attachResizeObserver = () => {
      attachFrameId = 0;
      const { scrollBox, scrollContent } = syncChatScrollRefs();
      if (!scrollBox || !scrollContent) return;
      if (scrollBox === observedScrollBox && scrollContent === observedScrollContent) return;

      disconnectResizeObserver();
      observedScrollBox = scrollBox;
      observedScrollContent = scrollContent;
      scrollLayoutMetricsRef.current = {
        scrollHeight: scrollBox.scrollHeight,
        clientHeight: scrollBox.clientHeight,
      };

      resizeObserver = new ResizeObserver(() => {
        if (frameId) {
          window.cancelAnimationFrame(frameId);
        }
        frameId = window.requestAnimationFrame(handleLayoutResize);
      });
      resizeObserver.observe(scrollBox);
      resizeObserver.observe(scrollContent);
    };

    const scheduleAttach = () => {
      if (attachFrameId) {
        window.cancelAnimationFrame(attachFrameId);
      }
      attachFrameId = window.requestAnimationFrame(attachResizeObserver);
    };

    scheduleAttach();
    const observerRoot = messageAreaRef.current ?? document.body;
    const mutationObserver = new MutationObserver(scheduleAttach);
    mutationObserver.observe(observerRoot, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
      if (attachFrameId) {
        window.cancelAnimationFrame(attachFrameId);
      }
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      disconnectResizeObserver();
    };
  }, [activeConversationId, bubbleListThemeKey, messages.length, syncChatScrollRefs, syncScrollToBottomVisibility]);

  // Scroll to bottom when streaming starts (user sent a message while scrolled up)
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (streaming && !prevStreamingRef.current) {
      // Delay to let the new message bubble render before scrolling
      setTimeout(() => {
        bubbleListRef.current?.scrollTo({ top: 'bottom', behavior: 'smooth' });
        setShowScrollToBottom(false);
        setStickToBottomState(true);
      }, 50);
    }
    prevStreamingRef.current = streaming;
  }, [setStickToBottomState, streaming]);

  // ── Export menu ────────────────────────────────────────────────────
  const exportMenuItems = useMemo(
    () => [
      {
        key: 'copy-md',
        label: t('chat.copyMarkdown', '复制 Markdown'),
        icon: <Copy size={14} />,
        onClick: async () => {
          if (messages.length === 0) { messageApi.warning(t('chat.noMessages')); return; }
          try {
            const ok = await copyTranscript(messages, activeConversation?.title ?? 'chat', 'markdown', { includeThinking: false });
            if (ok) messageApi.success(t('chat.copied'));
          } catch (e) { console.error('Copy MD failed:', e); messageApi.error(t('chat.exportFailed')); }
        },
      },
      {
        key: 'png',
        label: t('chat.exportPng'),
        icon: <FileImage size={14} />,
        onClick: async () => {
          try {
            const ok = await exportAsPNG(messageAreaRef.current, activeConversation?.title ?? 'chat');
            if (ok) messageApi.success(t('chat.exportSuccess'));
          } catch (e) { console.error('Export PNG failed:', e); messageApi.error(t('chat.exportFailed')); }
        },
      },
      {
        key: 'md',
        label: t('chat.exportMd'),
        icon: <FileCode size={14} />,
        onClick: async () => {
          if (messages.length === 0) { messageApi.warning(t('chat.noMessages')); return; }
          try {
            const ok = await exportAsMarkdown(messages, activeConversation?.title ?? 'chat');
            if (ok) messageApi.success(t('chat.exportSuccess'));
          } catch (e) { console.error('Export MD failed:', e); messageApi.error(t('chat.exportFailed')); }
        },
      },
      {
        key: 'export-md-no-thinking',
        label: t('chat.exportMdNoThinking', '导出 Markdown（不含思维链）'),
        icon: <FileCode size={14} />,
        onClick: async () => {
          if (messages.length === 0) { messageApi.warning(t('chat.noMessages')); return; }
          try {
            const ok = await exportAsMarkdown(messages, activeConversation?.title ?? 'chat', { includeThinking: false });
            if (ok) messageApi.success(t('chat.exportSuccess'));
          } catch (e) { console.error('Export MD (no thinking) failed:', e); messageApi.error(t('chat.exportFailed')); }
        },
      },
      {
        key: 'txt',
        label: t('chat.exportTxt'),
        icon: <FileType size={14} />,
        onClick: async () => {
          if (messages.length === 0) { messageApi.warning(t('chat.noMessages')); return; }
          try {
            const ok = await exportAsText(messages, activeConversation?.title ?? 'chat');
            if (ok) messageApi.success(t('chat.exportSuccess'));
          } catch (e) { console.error('Export TXT failed:', e); messageApi.error(t('chat.exportFailed')); }
        },
      },
      {
        key: 'export-txt-no-thinking',
        label: t('chat.exportTxtNoThinking', '导出文本（不含思维链）'),
        icon: <FileType size={14} />,
        onClick: async () => {
          if (messages.length === 0) { messageApi.warning(t('chat.noMessages')); return; }
          try {
            const ok = await exportAsText(messages, activeConversation?.title ?? 'chat', { includeThinking: false });
            if (ok) messageApi.success(t('chat.exportSuccess'));
          } catch (e) { console.error('Export TXT (no thinking) failed:', e); messageApi.error(t('chat.exportFailed')); }
        },
      },
      {
        key: 'json',
        label: t('chat.exportJson'),
        icon: <FileText size={14} />,
        onClick: async () => {
          if (messages.length === 0) { messageApi.warning(t('chat.noMessages')); return; }
          try {
            const ok = await exportAsJSON(messages, activeConversation?.title ?? 'chat');
            if (ok) messageApi.success(t('chat.exportSuccess'));
          } catch (e) { console.error('Export JSON failed:', e); messageApi.error(t('chat.exportFailed')); }
        },
      },
      {
        key: 'export-json-no-thinking',
        label: t('chat.exportJsonNoThinking', '导出 JSON（不含思维链）'),
        icon: <FileText size={14} />,
        onClick: async () => {
          if (messages.length === 0) { messageApi.warning(t('chat.noMessages')); return; }
          try {
            const ok = await exportAsJSON(messages, activeConversation?.title ?? 'chat', { includeThinking: false });
            if (ok) messageApi.success(t('chat.exportSuccess'));
          } catch (e) { console.error('Export JSON (no thinking) failed:', e); messageApi.error(t('chat.exportFailed')); }
        },
      },
    ],
    [messages, activeConversation, t, messageApi],
  );

  // ── Welcome prompt items ───────────────────────────────────────────
  const greetingText = useMemo(() => {
    const hour = new Date().getHours();
    let key: string;
    if (hour >= 5 && hour < 12) key = 'chat.greetingMorning';
    else if (hour >= 12 && hour < 14) key = 'chat.greetingNoon';
    else if (hour >= 14 && hour < 18) key = 'chat.greetingAfternoon';
    else key = 'chat.greetingEvening';
    return `👋 ${t(key)}`;
  }, [t]);

  const promptItems: PromptsItemType[] = useMemo(
    () => [
      { key: '1', icon: <Lightbulb size={16} />, label: t('chat.welcomePrompt1') },
      { key: '2', icon: <Languages size={16} />, label: t('chat.welcomePrompt2') },
      { key: '3', icon: <Code size={16} />, label: t('chat.welcomePrompt3') },
      { key: '4', icon: <Lightbulb size={16} />, label: t('chat.welcomePrompt4') },
    ],
    [t],
  );

  const handlePromptClick = useCallback(
    async (info: { data: PromptsItemType }) => {
      const text = typeof info.data.label === 'string' ? info.data.label : '';
      if (!text) return;

      try {
        if (!activeConversationId) {
          // Prefer settings default model, fall back to first enabled
          let provider = settings.default_provider_id
            ? providers.find((p) => p.id === settings.default_provider_id && p.enabled)
            : undefined;
          let model = provider?.models.find(
            (m) => m.model_id === settings.default_model_id && m.enabled,
          );
          if (!provider || !model) {
            provider = providers.find((p) => p.enabled && p.models.some((m) => m.enabled));
            model = provider?.models.find((m) => m.enabled);
          }
          if (!provider || !model) {
            messageApi.warning(t('chat.noModel'));
            return;
          }
          await createConversation(text.slice(0, 30), model.model_id, provider.id);
        }

        // Route through InputArea's send pipeline so companion models are respected
        useConversationStore.getState().setPendingPromptText(text);
      } catch (e) {
        console.error('[handlePromptClick] error:', e);
        messageApi.error(String(e));
      }
    },
    [activeConversationId, providers, settings, createConversation, messageApi, t],
  );

  // ── Bubble items (only show active messages) ────────────────────────
  const activeMessages = useMemo(
    () => messages.filter((msg) => msg.is_active !== false),
    [messages],
  );
  const messageById = useMemo(
    () => new Map(messages.map((msg) => [msg.id, msg])),
    [messages],
  );
  // Separate lookup: prefixed parent key → active assistant message (for stable bubble keys)
  const assistantByParentId = useMemo(() => {
    const map = new Map<string, Message>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.parent_message_id && msg.is_active !== false) {
        map.set(`ai:${msg.parent_message_id}`, msg);
      }
    }
    return map;
  }, [messages]);

  // Pre-compute parent IDs that have responses from multiple distinct models
  // (from in-store messages — may be incomplete after fetchMessages since DB only returns active)
  const multiModelResponseParents = useMemo(() => {
    const modelsByParent = new Map<string, Set<string>>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.parent_message_id) {
        if (!modelsByParent.has(msg.parent_message_id)) {
          modelsByParent.set(msg.parent_message_id, new Set());
        }
        // Use model_id if available; fall back to a per-message key so that
        // error messages (which may lack model_id) are still counted as
        // distinct model responses and don't break multi-model detection.
        modelsByParent.get(msg.parent_message_id)!.add(msg.model_id || `__no_model_${msg.id}`);
      }
    }
    const result = new Set<string>();
    for (const [parentId, models] of modelsByParent) {
      if (models.size > 1) result.add(parentId);
    }
    return result;
  }, [messages]);

  // Ref-based multi-model version cache — updated by AssistantFooter when it
  // loads all versions from DB (which includes inactive versions not in store).
  const multiModelVersionsRef = useRef<Map<string, Message[]>>(new Map());
  const handleMultiModelDetected = useCallback((parentMsgId: string, versions: Message[]) => {
    const hadCached = multiModelVersionsRef.current.has(parentMsgId);
    const stillMultiModel = hasMultipleModelVersions(versions);

    if (stillMultiModel) {
      multiModelVersionsRef.current.set(parentMsgId, versions);
    } else {
      multiModelVersionsRef.current.delete(parentMsgId);
    }

    if (hadCached !== stillMultiModel || !multiModelResponseParents.has(parentMsgId)) {
      // Trigger re-render so aiRole picks up the updated cache state.
      setDisplayModeOverrides((prev) => new Map(prev));
    }
  }, [multiModelResponseParents]);

  // Per-message display mode overrides (temporary, not persisted)
  const [displayModeOverrides, setDisplayModeOverrides] = useState<Map<string, MultiModelDisplayMode>>(new Map());
  const handleDisplayModeOverride = useCallback((parentMsgId: string, mode: MultiModelDisplayMode) => {
    setDisplayModeOverrides((prev) => {
      const next = new Map(prev);
      next.set(parentMsgId, mode);
      return next;
    });
  }, []);

  const userSearchContentById = useMemo(() => {
    const next = new Map<string, ReturnType<typeof parseSearchContent>>();
    for (const msg of activeMessages) {
      if (msg.role === 'user') {
        next.set(msg.id, parseSearchContent(msg.content));
      }
    }
    return next;
  }, [activeMessages]);

  const bubbleItemCacheRef = useRef<Map<string, { signature: string; item: BubbleItemType }>>(new Map());
  const bubbleItems: BubbleItemType[] = useMemo(() => {
    const cache = bubbleItemCacheRef.current;
    const nextCache = new Map<string, { signature: string; item: BubbleItemType }>();
    const nextItems: BubbleItemType[] = [];

    for (const msg of activeMessages) {
      // Skip tool result messages (displayed inline via :::mcp containers)
      if (msg.role === 'tool') continue;

      if (msg.role === 'system' && msg.content === '<!-- context-clear -->') {
        const signature = 'context-clear';
        const cached = cache.get(msg.id);
        const item = cached?.signature === signature
          ? cached.item
          : {
              key: msg.id,
              role: 'context-clear',
              content: msg.id,
              variant: 'borderless' as const,
            };
        nextCache.set(msg.id, { signature, item });
        nextItems.push(item);
        continue;
      }

      if (msg.role === 'system' && msg.content === '<!-- context-compressed -->') {
        const signature = 'context-compressed';
        const cached = cache.get(msg.id);
        const item = cached?.signature === signature
          ? cached.item
          : {
              key: msg.id,
              role: 'context-compressed',
              content: msg.id,
              variant: 'borderless' as const,
            };
        nextCache.set(msg.id, { signature, item });
        nextItems.push(item);
        continue;
      }

      if (msg.role === 'user') {
        const { userContent } = userSearchContentById.get(msg.id) ?? parseSearchContent(msg.content);
        const signature = `user:${userContent}`;
        const cached = cache.get(msg.id);
        const item = cached?.signature === signature
          ? cached.item
          : { key: msg.id, role: 'user', content: userContent };
        nextCache.set(msg.id, { signature, item });
        nextItems.push(item);
        continue;
      }

      let aiContent = msg.role === 'assistant'
        ? buildAssistantDisplayContent(msg, activeMessages)
        : msg.content;
      if (shouldHideAssistantBubble(msg, aiContent)) continue;
      // Close unclosed think block during streaming
      if (msg.role === 'assistant' && thinkingActiveMessageIds.has(msg.id) && aiContent.includes('<think')) {
        const lastOpen = aiContent.lastIndexOf('<think');
        const lastClose = aiContent.lastIndexOf('</think>');
        if (lastClose < lastOpen) {
          aiContent += THINKING_LOADING_MARKER + '\n</think>\n\n';
        }
      }
      if (msg.role === 'assistant' && !aiContent.includes('data-aqbot="1"')) {
        const parentSearch = msg.parent_message_id
          ? userSearchContentById.get(msg.parent_message_id)
          : undefined;
        if (parentSearch?.hasSearch && parentSearch.sources.length > 0) {
          const { sources } = parentSearch;
          const resultsJson = JSON.stringify(sources.map((s) => ({ title: s.title, url: s.url })));
          aiContent = `<web-search status="done" data-aqbot="1">\n${resultsJson}\n</web-search>\n\n${aiContent}`;
        }
      }

      // Use parent_message_id as stable key for assistant bubbles to avoid
      // unmount/remount flash when switching versions. Prefix with "ai:" to
      // prevent key collision with the user message (which shares the same id).
      // Skip duplicate assistant messages with the same parent (multi-model parallel race).
      const stableKey = msg.parent_message_id ? `ai:${msg.parent_message_id}` : msg.id;
      if (nextCache.has(stableKey)) continue; // already rendered for this parent
      const signature = `ai:${msg.id}:${aiContent}`;
      const cached = cache.get(stableKey);
      const item = cached?.signature === signature
        ? cached.item
        : { key: stableKey, role: 'ai', content: aiContent };
      nextCache.set(stableKey, { signature, item });
      nextItems.push(item);
    }

    bubbleItemCacheRef.current = nextCache;
    return nextItems;
  }, [activeMessages, thinkingActiveMessageIds, userSearchContentById]);

  // Append compressing placeholder when compression is in progress
  const finalBubbleItems = useMemo(() => {
    if (!compressing) return bubbleItems;
    return [
      ...bubbleItems,
      {
        key: '__compressing__',
        role: 'context-compressing',
        content: '',
        variant: 'borderless' as const,
      },
    ];
  }, [bubbleItems, compressing]);

  const lastBubbleKey = finalBubbleItems.length > 0
    ? String(finalBubbleItems[finalBubbleItems.length - 1].key)
    : '';

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      if (stickToBottom) {
        bubbleListRef.current?.scrollTo({ top: 'bottom', behavior: 'auto' });
        setShowScrollToBottom(false);
        return;
      }
      syncScrollToBottomVisibility();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [finalBubbleItems, stickToBottom, syncScrollToBottomVisibility]);

  useEffect(() => {
    if (!activeConversationId || bubbleItems.length === 0) return;
    if (pendingScrollConversationIdRef.current !== activeConversationId) return;

    let frame1 = 0;
    let frame2 = 0;
    frame1 = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        bubbleListRef.current?.scrollTo({ top: 'bottom', behavior: 'auto' });
        pendingScrollConversationIdRef.current = null;
      });
    });

    return () => {
      window.cancelAnimationFrame(frame1);
      window.cancelAnimationFrame(frame2);
    };
  }, [activeConversationId, bubbleItems.length, lastBubbleKey]);
  const aiContentNodesCacheRef = useRef<Map<string, {
    content: string;
    nodes: ChatMarkdownNode[];
  }>>(new Map());
  const aiContentNodesById = useMemo(() => {
    const cache = aiContentNodesCacheRef.current;
    const next = new Map<string, ChatMarkdownNode[]>();

    for (const item of bubbleItems) {
      if (item.role !== 'ai' || typeof item.content !== 'string') {
        continue;
      }
      // Skip error messages — they render as Alert, not markdown
      const msg = assistantByParentId.get(String(item.key)) ?? messageById.get(String(item.key));
      if (msg?.status === 'error') {
        continue;
      }
      // Skip the actively streaming message — NodeRenderer handles incremental
      // parsing via its `content` prop. Keep that same renderer path after
      // completion so the message does not switch from `content` to
      // `nodes` and visibly re-render a second time.
      const shouldRenderFromContent = shouldRenderAssistantMarkdownFromContent(
        streaming && msg?.id === streamingMessageId,
        Boolean(msg?.id && contentRendererMessageIdsRef.current.has(msg.id)),
      );
      if (shouldRenderFromContent) {
        continue;
      }

      const messageId = String(item.key);
      const cached = cache.get(messageId);
      if (cached && cached.content === item.content) {
        next.set(messageId, cached.nodes);
        continue;
      }

      const nodes = parseChatMarkdown(item.content);
      cache.set(messageId, { content: item.content, nodes });
      next.set(messageId, nodes);
    }

    for (const messageId of Array.from(cache.keys())) {
      if (!next.has(messageId)) {
        cache.delete(messageId);
      }
    }

    return next;
  }, [bubbleItems, assistantByParentId, messageById, streaming, streamingMessageId]);
  // ── Format timestamp ──────────────────────────────────────────────
  const formatTime = useCallback((ts: number) => {
    return formatChatTime(ts);
  }, []);

  // ── Resolve model name for the conversation ──────────────────────
  const getModelDisplayInfo = useCallback((modelId?: string | null, providerId?: string | null) => {
    const mid = modelId ?? activeConversation?.model_id;
    const pid = providerId ?? activeConversation?.provider_id;
    if (!mid) return { modelName: 'AI', providerName: '' };
    const provider = providers.find((p) => p.id === pid);
    const model = provider?.models.find((m) => m.model_id === mid);
    return { modelName: model?.name ?? mid, providerName: provider?.name ?? '' };
  }, [activeConversation, providers]);

  const handleEditMessage = useCallback((messageId: string, content: string, role: 'user' | 'assistant') => {
    setEditingMessageId(messageId);
    setEditingMessageRole(role);
    setEditingContent(content);
  }, []);

  const handleEditSaveOnly = useCallback(async () => {
    if (!editingMessageId) return;
    setEditSaving(true);
    try {
      await updateMessageContent(editingMessageId, editingContent);
      setEditingMessageId(null);
      setEditingMessageRole(null);
      setEditingContent('');
    } catch (e) {
      messageApi.error(String(e));
    } finally {
      setEditSaving(false);
    }
  }, [editingMessageId, editingContent, updateMessageContent, messageApi]);

  const handleEditSaveAndResend = useCallback(async () => {
    if (!editingMessageId) return;
    setEditSaving(true);
    try {
      await updateMessageContent(editingMessageId, editingContent);
      // regenerateMessage expects an AI message ID to find the parent user message
      const msgs = useConversationStore.getState().messages;
      const aiMsg = msgs.find(m => m.parent_message_id === editingMessageId && m.is_active);
      setEditingMessageId(null);
      setEditingMessageRole(null);
      setEditingContent('');
      await regenerateMessage(aiMsg?.id);
    } catch (e) {
      messageApi.error(String(e));
    } finally {
      setEditSaving(false);
    }
  }, [editingMessageId, editingContent, updateMessageContent, regenerateMessage, messageApi]);

  // ── Roles ──────────────────────────────────────────────────────────
  const userRole = useCallback((bubbleData: BubbleItemType) => {
    const msg = messageById.get(String(bubbleData.key));
    const attachments = msg?.attachments ?? [];
    return {
      placement: 'end' as const,
      ...getBubbleVariant(true),
      avatar: userAvatar,
      contentRender: attachments.length > 0
        ? (content: string) => (
            <div style={{ textAlign: 'right' }}>
              <span data-aqbot-msg={msg?.id} style={{ height: 0, overflow: 'hidden', lineHeight: 0 }} />
              {content && (
                settings.render_user_markdown
                  ? <AssistantMarkdown
                      content={content}
                      isDarkMode={isDarkMode}
                      isStreaming={false}
                      codeBlockDarkTheme={codeBlockDarkTheme}
                      codeBlockLightTheme={codeBlockLightTheme}
                      codeBlockThemes={codeBlockThemes}
                      codeFontFamily={settings.code_font_family || undefined}
                    />
                  : <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: content ? 8 : 0, justifyContent: 'flex-end' }}>
                {attachments.map((att, i) => (
                  <AttachmentPreview
                    key={att.id || `${att.file_name}-${i}`}
                    att={att}
                    themeColor={token.colorPrimary}
                  />
                ))}
              </div>
            </div>
          )
        : (content: string) => (
            <>
              <span data-aqbot-msg={msg?.id} style={{ height: 0, overflow: 'hidden', lineHeight: 0 }} />
              {settings.render_user_markdown
                ? <AssistantMarkdown
                    content={content}
                    isDarkMode={isDarkMode}
                    isStreaming={false}
                    codeBlockDarkTheme={codeBlockDarkTheme}
                    codeBlockLightTheme={codeBlockLightTheme}
                    codeBlockThemes={codeBlockThemes}
                    codeFontFamily={settings.code_font_family || undefined}
                  />
                : content
              }
            </>
          ),
      header: (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Typography.Text style={{ fontSize: 13 }}>{profile.name || t('chat.you')}</Typography.Text>
            {msg && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {formatTime(msg.created_at)}
              </Typography.Text>
            )}
          </div>
        </div>
      ),
      footer: (
        <Actions
          items={[
            {
              key: 'copy',
              icon: (() => { const ct = stripAqbotTags(String(bubbleData.content ?? '')); return isUserMsgCopied(ct) ? <Check size={14} style={{ color: token.colorSuccess }} /> : <Copy size={14} />; })(),
              label: t('chat.copy'),
              onItemClick: () => {
                void copyMessage(stripAqbotTags(String(bubbleData.content ?? ''))).then(ok => {
                  if (ok) messageApi.success(t('chat.copied'));
                });
              },
            },
            {
              key: 'edit',
              icon: <Pencil size={14} />,
              label: t('chat.editMessage'),
              onItemClick: () => {
                if (msg) {
                  handleEditMessage(msg.id, msg.content, 'user');
                }
              },
            },
            {
              key: 'regenerate',
              icon: <RotateCcw size={14} />,
              label: t('chat.regenerate'),
              onItemClick: async () => {
                try {
                  await regenerateMessage(msg?.id);
                } catch (e) {
                  messageApi.error(String(e));
                }
              },
            },
            {
              key: 'delete',
              actionRender: () => (
                <Popconfirm
                  title={t('chat.confirmDeleteMessage')}
                  onConfirm={async () => {
                    if (msg && activeConversationId) {
                      try {
                        await deleteMessageGroup(activeConversationId, msg.id);
                      } catch (e) {
                        messageApi.error(String(e));
                      }
                    }
                  }}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                >
                  <Tooltip title={t('chat.delete')}>
                    <span className="aqbot-action-item" style={{ color: token.colorError }}>
                      <Trash2 size={14} />
                    </span>
                  </Tooltip>
                </Popconfirm>
              ),
            },
          ]}
        />
      ),
    };
  }, [activeConversationId, codeBlockDarkTheme, codeBlockLightTheme, codeBlockThemes, deleteMessageGroup, formatTime, getBubbleVariant, handleEditMessage, isDarkMode, messageApi, messageById, profile.name, regenerateMessage, settings.code_font_family, settings.render_user_markdown, t, token.colorError, token.colorPrimary, userAvatar]);

  const aiRole = useCallback((bubbleData: BubbleItemType) => {
    // bubbleData.key is parent_message_id for stable rendering
    const msg = assistantByParentId.get(String(bubbleData.key)) ?? messageById.get(String(bubbleData.key));
    const isStreaming = streaming && msg?.id === streamingMessageId;
    const shouldRenderFromContent = shouldRenderAssistantMarkdownFromContent(
      isStreaming,
      Boolean(msg?.id && contentRendererMessageIdsRef.current.has(msg.id)),
    );
    const assistantCopyText = stripAqbotTags(msg?.content ?? (typeof bubbleData.content === 'string' ? bubbleData.content : ''));
    const ragDisplayPrefix = msg?.id ? ragDisplayByMessageId[msg.id] : undefined;
    const parsedNodes = shouldRenderFromContent || ragDisplayPrefix
      ? undefined
      : aiContentNodesById.get(String(bubbleData.key));
    const { footerLoading: rawFooterLoading } = getStreamingLoadingState(isStreaming, bubbleData.content);
    const hasModelText = hasModelVisibleContent(bubbleData.content, stripAqbotTags);
    const footerLoading = rawFooterLoading && hasModelText;
    // Never let Ant Design Bubble's loading state replace AI content while a
    // stream is active; the markdown renderer receives incremental content and
    // the content area renders its own lightweight placeholder before the first token.
    const isAgentMsg = activeConversation?.mode === 'agent';
    const bubbleLoading = false;

    // Determine effective display mode for this message
    const parentId = msg?.parent_message_id;
    // Check both store-based detection and ref-based detection (from AssistantFooter DB queries)
    const hasMultiModels = !!parentId && (
      multiModelResponseParents.has(parentId) || multiModelVersionsRef.current.has(parentId)
    );
    const effectiveDisplayMode: MultiModelDisplayMode = hasMultiModels
      ? (displayModeOverrides.get(parentId) ?? settings.multi_model_display_mode ?? 'tabs')
      : 'tabs';
    const isNonTabsMultiModel = hasMultiModels && effectiveDisplayMode !== 'tabs';
    const renderVersionContent = (versionMessage: Message, isVersionStreaming: boolean) => {
      const versionContent = buildAssistantDisplayContent(versionMessage, activeMessages);
      if (versionMessage.status === 'error') {
        return <Alert type="error" message={versionContent} showIcon />;
      }
      return (
        <AssistantMarkdown
          content={versionContent}
          isDarkMode={isDarkMode}
          isStreaming={isVersionStreaming}
          codeBlockDarkTheme={codeBlockDarkTheme}
          codeBlockLightTheme={codeBlockLightTheme}
          codeBlockThemes={codeBlockThemes}
          codeFontFamily={settings.code_font_family || undefined}
        />
      );
    };

    return {
      placement: 'start' as const,
      ...getBubbleVariant(false),
      avatar: isNonTabsMultiModel ? undefined : renderConvIconForChat(32, msg?.model_id),
      loading: bubbleLoading,
      contentRender: (content: string) => {
        const renderContent = typeof content === 'string' && content.length > 0
          ? content
          : (msg?.content ?? '');
        const renderLoadingState = getStreamingLoadingState(isStreaming, renderContent);
        const hasDisplayContent = hasAqbotDisplayContent(renderContent) || Boolean(ragDisplayPrefix);
        const hasRenderedModelText = hasModelVisibleContent(renderContent, stripAqbotTags);
        const shouldShowInitialDots = renderLoadingState.bubbleLoading && !hasDisplayContent;
        const msgMarker = <span data-aqbot-msg={msg?.id} style={{ height: 0, overflow: 'hidden', lineHeight: 0 }} />;
        // Multi-model non-tabs mode: render all versions in side-by-side or stacked layout
        if (isNonTabsMultiModel && parentId && activeConversationId) {
          // Prefer ref-based versions (from AssistantFooter DB query, includes inactive)
          // Fall back to store-based versions (only has active during normal load)
          const refVersions = multiModelVersionsRef.current.get(parentId);
          const storeVersions = messages.filter(
            (m) => m.parent_message_id === parentId && m.role === 'assistant',
          );
          const allVersions = selectRenderableVersionSet(storeVersions, refVersions);
          return (
            <>
              {msgMarker}
              <MultiModelDisplay
                versions={allVersions}
                activeMessageId={msg!.id}
                mode={effectiveDisplayMode as 'side-by-side' | 'stacked'}
                conversationId={activeConversationId}
                onSwitchVersion={(pid, mid) => switchMessageVersion(activeConversationId, pid, mid)}
                onDeleteVersion={(mid) => deleteMessage(mid)}
                streamingMessageId={streamingMessageId}
                multiModelDoneMessageIds={multiModelDoneMessageIds}
                getModelDisplayInfo={getModelDisplayInfo}
                renderContent={renderVersionContent}
              />
            </>
          );
        }

        if (shouldRenderStandaloneAssistantError(msg?.status, isNonTabsMultiModel)) {
          return <>{msgMarker}<Alert type="error" message={content} showIcon /></>;
        }

        if (!isAgentMsg && shouldShowInitialDots) {
          return (
            <>{msgMarker}<span className="aqbot-streaming-dots" aria-hidden="true">
              <span /><span /><span />
            </span></>
          );
        }

        const isAgentMode = activeConversation?.mode === 'agent';
        const msgPermissions = isAgentMode && msg && activeConversationId
          ? Object.values(agentPendingPermissions).filter((pr) =>
              pr.conversationId === activeConversationId && (
                pr.assistantMessageId === msg.id ||
                // Fallback: permission emitted before assistant message ID was set
                (pr.assistantMessageId === '' && msg.id === streamingMessageId)
              )
            )
          : [];
        const msgAskUsers = isAgentMode && msg && activeConversationId
          ? Object.values(agentPendingAskUser).filter((ask) =>
              ask.conversationId === activeConversationId && (
                ask.assistantMessageId === msg.id ||
                (ask.assistantMessageId === '' && msg.id === streamingMessageId)
              )
            )
          : [];

        // In agent mode: show inline loading dots only when no content AND no permissions/asks yet
        if (isAgentMsg && shouldShowInitialDots && msgPermissions.length === 0 && msgAskUsers.length === 0) {
          return (
            <>{msgMarker}<span className="aqbot-streaming-dots" aria-hidden="true">
              <span /><span /><span />
            </span></>
          );
        }

        return (
          <>
            {msgMarker}
            <AssistantMarkdown
              content={renderContent}
              nodes={parsedNodes}
              isDarkMode={isDarkMode}
              isStreaming={isStreaming}
              codeBlockDarkTheme={codeBlockDarkTheme}
              codeBlockLightTheme={codeBlockLightTheme}
              codeBlockThemes={codeBlockThemes}
              codeFontFamily={settings.code_font_family || undefined}
              displayPrefix={ragDisplayPrefix}
            />
            {!isAgentMsg && isStreaming && hasDisplayContent && !hasRenderedModelText && (
              <div className="aqbot-streaming-dots" aria-hidden="true" style={{ marginTop: 8 }}>
                <span /><span /><span />
              </div>
            )}
            {msgPermissions.map((pr) => {
              const resolvedTc = agentToolCalls[pr.toolUseId];
              const permStatus = resolvedTc?.approvalStatus === 'approved'
                ? 'approved'
                : resolvedTc?.approvalStatus === 'denied'
                  ? 'denied'
                  : 'pending';
              return (
                <PermissionCard
                  key={pr.toolUseId}
                  conversationId={pr.conversationId}
                  toolUseId={pr.toolUseId}
                  toolName={pr.toolName}
                  input={pr.input}
                  status={permStatus}
                />
              );
            })}
            {msgAskUsers.map((ask) => (
              <AskUserCard
                key={ask.askId}
                askId={ask.askId}
                conversationId={ask.conversationId}
                question={ask.question}
                options={ask.options}
              />
            ))}
            {/* Show loading dots when agent is streaming but footer dots are NOT showing (no text content yet) */}
            {isAgentMsg && isStreaming && !footerLoading && (
              <div className="aqbot-streaming-dots" aria-hidden="true" style={{ marginTop: 8 }}>
                <span /><span /><span />
              </div>
            )}
          </>
        );
      },
      header: (() => {
        if (isNonTabsMultiModel) return null;
        const { modelName, providerName } = getModelDisplayInfo(msg?.model_id, msg?.provider_id);
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {providerName && (
                <Tag style={{ fontSize: 11, margin: 0, padding: '0 4px', lineHeight: '18px', color: token.colorPrimary, backgroundColor: token.colorPrimaryBg, border: 'none' }}>{providerName}</Tag>
              )}
              <Typography.Text style={{ fontSize: 13 }}>
                {modelName}
              </Typography.Text>
              {msg && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {formatTime(msg.created_at)}
                </Typography.Text>
              )}
              {msg?.status === 'partial' && !isStreaming && !(multiModelParentId && msg.parent_message_id === multiModelParentId) && (
                <Tag color="warning" style={{ fontSize: 10, margin: 0, padding: '0 4px', lineHeight: '16px', border: 'none' }}>
                  {t('chat.partial')}
                </Tag>
              )}
            </div>
          </div>
        );
      })(),
      footer: msg && activeConversationId ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {footerLoading && !isNonTabsMultiModel && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                color: token.colorPrimary,
              }}
              aria-label={t('chat.generating')}
            >
              <span className="aqbot-streaming-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </div>
          )}
          <AssistantFooter
            msg={msg}
            conversationId={activeConversationId}
            assistantCopyText={assistantCopyText}
            getModelDisplayInfo={getModelDisplayInfo}
            onEditMessage={handleEditMessage}
            isStreaming={isStreaming}
            displayMode={effectiveDisplayMode}
            onDisplayModeChange={handleDisplayModeOverride}
            onMultiModelDetected={handleMultiModelDetected}
          />
        </div>
      ) : footerLoading ? (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: token.colorPrimary,
          }}
          aria-label={t('chat.generating')}
        >
          <span className="aqbot-streaming-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : null,
    };
  }, [activeConversation, activeConversationId, activeMessages, agentPendingPermissions, agentToolCalls, aiContentNodesById, assistantByParentId, codeBlockDarkTheme, codeBlockLightTheme, codeBlockThemes, deleteMessage, displayModeOverrides, formatTime, getBubbleVariant, getModelDisplayInfo, handleDisplayModeOverride, handleEditMessage, handleMultiModelDetected, isDarkMode, messageById, messages, multiModelDoneMessageIds, multiModelParentId, multiModelResponseParents, ragDisplayByMessageId, renderConvIconForChat, settings, streaming, streamingMessageId, switchMessageVersion, t, token.colorPrimary, token.colorTextDescription]);

  const contextClearRole = useCallback((bubbleData: BubbleItemType) => {
    const msgId = String(bubbleData.content ?? '');
    return {
      placement: 'start' as const,
      variant: 'borderless' as const,
      className: 'context-clear-bubble',
      contentRender: () => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 0', width: '100%' }}>
          <div style={{ flex: 1, height: 1, borderTop: `1px dashed ${token.colorBorderSecondary}` }} />
          <span
            style={{
              margin: '0 12px',
              color: token.colorTextQuaternary,
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            <Scissors size={14} style={{ marginRight: 4 }} /> {t('chat.contextCleared')}
            <X
              size={14}
              style={{ marginLeft: 6, cursor: 'pointer' }}
              onClick={() => {
                void removeContextClear(msgId).catch((err) => {
                  messageApi.error(String(err));
                });
              }}
            />
          </span>
          <div style={{ flex: 1, height: 1, borderTop: `1px dashed ${token.colorBorderSecondary}` }} />
        </div>
      ),
    };
  }, [messageApi, removeContextClear, t, token.colorBorderSecondary, token.colorTextQuaternary]);

  const contextCompressedRole = useCallback((_bubbleData: BubbleItemType) => {
    return {
      placement: 'start' as const,
      variant: 'borderless' as const,
      className: 'context-clear-bubble',
      contentRender: () => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 0', width: '100%' }}>
          <div style={{ flex: 1, height: 1, borderTop: `1px dashed ${token.colorPrimaryBorder}` }} />
          <span
            style={{
              margin: '0 12px',
              color: token.colorPrimary,
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              cursor: 'pointer',
              gap: 4,
            }}
          >
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={async () => {
                const convId = activeConversationId;
                if (!convId) return;
                const summary = await getCompressionSummary(convId);
                setSummaryModalText(summary?.summary_text ?? t('chat.noSummary'));
                setSummaryModalOpen(true);
              }}
            >
              <Zap size={14} /> {t('chat.contextCompressed')}
            </span>
            <Popconfirm
              title={t('chat.deleteCompressionConfirm')}
              onConfirm={async () => {
                try {
                  await deleteCompression();
                } catch {
                  // error already logged in store
                }
              }}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <X
                size={14}
                style={{ cursor: 'pointer', color: token.colorTextTertiary, flexShrink: 0 }}
                onClick={(e) => e.stopPropagation()}
              />
            </Popconfirm>
          </span>
          <div style={{ flex: 1, height: 1, borderTop: `1px dashed ${token.colorPrimaryBorder}` }} />
        </div>
      ),
    };
  }, [activeConversationId, deleteCompression, getCompressionSummary, t, token.colorPrimary, token.colorPrimaryBorder, token.colorTextTertiary]);

  const contextCompressingRole = useCallback(() => {
    return {
      placement: 'start' as const,
      variant: 'borderless' as const,
      className: 'context-clear-bubble',
      contentRender: () => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 0', width: '100%' }}>
          <div style={{ flex: 1, height: 1, borderTop: `1px dashed ${token.colorPrimaryBorder}` }} />
          <span
            style={{
              margin: '0 12px',
              color: token.colorPrimary,
              fontSize: 12,
              display: 'inline-flex',
              alignItems: 'center',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            <Spin size="small" style={{ marginRight: 6 }} /> {t('chat.compressing')}
          </span>
          <div style={{ flex: 1, height: 1, borderTop: `1px dashed ${token.colorPrimaryBorder}` }} />
        </div>
      ),
    };
  }, [t, token.colorPrimary, token.colorPrimaryBorder]);

  const roles: RoleType = useMemo(() => ({
    user: userRole,
    ai: aiRole,
    'context-clear': contextClearRole,
    'context-compressed': contextCompressedRole,
    'context-compressing': contextCompressingRole,
  }), [aiRole, contextClearRole, contextCompressedRole, contextCompressingRole, userRole]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Bubble style overrides */}
      <style>{`
        @keyframes aqbot-think-spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes aqbot-stream-dot-bounce {
          0%, 80%, 100% {
            transform: translateY(0);
            opacity: 0.45;
          }
          40% {
            transform: translateY(-3px);
            opacity: 1;
          }
        }
        .ant-bubble-end .ant-bubble-content {
          width: auto;
          max-width: 100%;
          margin-inline-start: auto;
        }
        .ant-bubble,
        .ant-bubble-content-wrapper,
        .ant-bubble-body {
          min-width: 0;
          max-width: 100%;
        }
        .ant-bubble-footer {
          margin-block-start: 4px !important;
        }
        .ant-bubble-start .ant-bubble-body {
          width: 100%;
        }
        .ant-bubble-content {
          overflow: hidden;
          min-width: 0;
        }
        .ant-bubble-content .markstream-react {
          overflow: hidden;
          min-width: 0;
        }
        .ant-bubble-content .ant-think,
        .ant-bubble-content .ant-think-content,
        .ant-bubble-content .ant-think-description {
          max-width: 100%;
          min-width: 0;
          overflow: hidden;
        }
        .ant-bubble-content .code-block-node,
        .ant-bubble-content .code-block-container {
          overflow-x: auto;
          max-width: 100%;
          min-width: 0 !important;
          width: 100%;
          box-sizing: border-box;
        }
        .bubble-compact .ant-bubble {
          margin-bottom: 4px;
        }
        .bubble-compact .ant-bubble-content {
          padding: 6px 10px;
        }
        .context-clear-bubble.ant-bubble {
          width: 100%;
          padding-inline-end: 0 !important;
          padding-inline-start: 0 !important;
        }
        .context-clear-bubble .ant-bubble-content-wrapper {
          flex: 1;
        }
        .bubble-minimal .ant-bubble-content {
          background: transparent !important;
          box-shadow: none !important;
          border: none !important;
          padding: 4px 0;
        }
        .aqbot-streaming-dots {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-height: 16px;
        }
        .aqbot-streaming-dots span {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: currentColor;
          animation: aqbot-stream-dot-bounce 1s ease-in-out infinite;
        }
        .aqbot-streaming-dots span:nth-child(2) {
          animation-delay: 0.15s;
        }
        .aqbot-streaming-dots span:nth-child(3) {
          animation-delay: 0.3s;
        }
      `}</style>

      {/* Top Bar */}
      <div className="flex items-center gap-2 px-3 py-3">
        {activeConversation ? (
          <>
            {renderConvIconForChat(24)}
            {editingTitle ? (
              <div className="flex items-center gap-1">
                <Input
                  ref={titleInputRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={handleTitleSave}
                  onPressEnter={handleTitleSave}
                  size="small"
                  style={{ maxWidth: 240 }}
                />
                <Tooltip title={t('chat.aiGenerateTitle')}>
                  <Button
                    type="text"
                    size="small"
                    icon={isTitleGenerating ? <SyncOutlined spin /> : <Sparkles size={14} />}
                    disabled={isTitleGenerating}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => { e.stopPropagation(); handleRegenerateTitle(); }}
                  />
                </Tooltip>
              </div>
            ) : (
              <Typography.Text
                className="cursor-pointer select-none"
                onClick={handleTitleClick}
              >
                {activeConversation.title}
                {isTitleGenerating
                  ? <SyncOutlined spin className="ml-1 text-xs opacity-50" />
                  : <Pencil size={12} className="ml-1 text-xs opacity-50" />
                }
              </Typography.Text>
            )}

            <div className="flex-1" />

            <ModelSelector />
            <Popover
              content={<StatsPopoverContent stats={stats} t={t} token={token} />}
              trigger="click"
              open={statsOpen}
              onOpenChange={handleStatsOpenChange}
              placement="bottomRight"
            >
              <Tooltip title={t('chat.stats.title')}>
                <Button type="text" icon={<ChartNoAxesColumn size={14} />} size="small" />
              </Tooltip>
            </Popover>
            <Dropdown menu={{ items: exportMenuItems }} trigger={['click']}>
              <Button type="text" icon={<Share2 size={14} />} size="small" />
            </Dropdown>
          </>
        ) : (
          <>
            <Typography.Text type="secondary">{t('chat.welcome')}</Typography.Text>
            <div className="flex-1" />
            <ModelSelector />
          </>
        )}
      </div>

      {/* Message Area */}
      <div ref={messageAreaRef} data-message-area className={`flex-1 min-h-0 overflow-hidden relative bubble-${bubbleStyle || 'modern'}`}>
        {messages.length === 0 ? (
          activeConversationId && loading ? (
            <div
              className="flex flex-col items-center justify-center h-full"
              style={{ gap: 12, padding: '0 24px', color: token.colorTextSecondary }}
            >
              <SyncOutlined spin style={{ fontSize: 20, color: token.colorPrimary }} />
              <Typography.Text type="secondary">
                {t('chat.loadingConversation')}
              </Typography.Text>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full" style={{ padding: '0 24px' }}>
              <Typography.Title level={3} style={{ marginBottom: 24, fontWeight: 500 }}>
                {greetingText}
              </Typography.Title>
              <Prompts
                items={promptItems}
                onItemClick={handlePromptClick}
                wrap
                style={{ marginTop: 16 }}
              />
            </div>
          )
        ) : (
          <>
            <Bubble.List
              key={bubbleListThemeKey}
              ref={bubbleListRef}
              items={finalBubbleItems}
              autoScroll={false}
              onScroll={handleBubbleListScroll}
              role={roles}
              style={{
                height: '100%',
                padding: settings.chat_minimap_enabled && settings.chat_minimap_style === 'sticky'
                  ? '50px 24px 16px 24px'
                  : '16px 24px',
                overflowX: 'hidden',
              }}
            />
            <ChatScrollIndicator onUserScrollIntent={markUserScrollIntent} />
            <MinimapScrollProvider scrollTo={minimapScrollTo} scrollBoxRef={scrollBoxRef}>
              <ChatMinimap />
            </MinimapScrollProvider>
          </>
        )}
      </div>

      {/* Agent status bar */}
      {currentAgentStatus && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 24px',
            fontSize: 13,
            color: token.colorTextSecondary,
          }}
        >
          <Spin size="small" /> {currentAgentStatus}
        </div>
      )}

      {/* Input Area */}
      <div className="relative">
        {showScrollToBottom && (
          <Button
            size="small"
            shape="round"
            icon={<ChevronDown size={14} />}
            onClick={handleScrollToBottom}
            style={{
              position: 'absolute',
              left: '50%',
              top: -28,
              zIndex: 2,
              transform: 'translateX(-50%)',
              boxShadow: token.boxShadowSecondary,
            }}
          >
            {t('chat.scrollToBottom')}
          </Button>
        )}
        <InputArea />
      </div>
      <Modal
        title={t('chat.compressionSummary')}
        open={summaryModalOpen}
        onCancel={() => setSummaryModalOpen(false)}
        footer={null}
        width={640}
      >
        <div style={{ maxHeight: 480, overflow: 'auto', padding: '8px 0' }}>
          <NodeRenderer
            content={summaryModalText}
            isDark={isDarkMode}
            customId="summary"
            final
            themes={codeBlockThemes}
            codeBlockLightTheme={codeBlockLightTheme}
            codeBlockDarkTheme={codeBlockDarkTheme}
          />
        </div>
      </Modal>
      <Modal
        title={t('chat.editMessage')}
        open={!!editingMessageId}
        onCancel={() => {
          setEditingMessageId(null);
          setEditingMessageRole(null);
          setEditingContent('');
        }}
        footer={[
          <Button key="cancel" onClick={() => { setEditingMessageId(null); setEditingMessageRole(null); setEditingContent(''); }}>
            {t('common.cancel')}
          </Button>,
          <Button key="save" onClick={handleEditSaveOnly} loading={editSaving}>
            {t('chat.saveOnly')}
          </Button>,
          ...(editingMessageRole === 'assistant' ? [] : [
            <Button key="saveResend" type="primary" onClick={handleEditSaveAndResend} loading={editSaving}>
              {t('chat.saveAndResend')}
            </Button>,
          ]),
        ]}
        width={640}
      >
        <Input.TextArea
          value={editingContent}
          onChange={(e) => setEditingContent(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 12 }}
          style={{ marginTop: 8 }}
        />
      </Modal>
      <CodeBlockPreviewModal
        payload={previewPayload}
        open={previewModalOpen}
        onClose={() => setPreviewModalOpen(false)}
      />
      <Modal
        title={`Mermaid ${t('common.preview')}`}
        open={mermaidPreviewOpen}
        onCancel={() => { setMermaidPreviewOpen(false); setMermaidPreviewSvg(null); }}
        footer={null}
        width="80vw"
        style={{ top: 32 }}
        styles={{ body: { height: 'calc(80vh - 55px)', overflow: 'auto', padding: 16 } }}
        destroyOnClose
      >
        {mermaidPreviewSvg && (
          <div
            style={{ width: '100%', display: 'flex', justifyContent: 'center' }}
            dangerouslySetInnerHTML={{ __html: mermaidPreviewSvg }}
          />
        )}
      </Modal>
    </div>
  );
}
