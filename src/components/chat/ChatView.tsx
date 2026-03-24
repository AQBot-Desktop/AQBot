import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { CloseCircleFilled, SyncOutlined } from '@ant-design/icons';
import { Typography, Button, Dropdown, Input, App, Avatar, Alert, Modal, Popconfirm, theme, Tag, Image } from 'antd';
import type { InputRef } from 'antd';
import { Pencil, Share2, FileImage, FileCode, FileText, FileType, Bot, Brain, Lightbulb, Code, Languages, Copy, RotateCcw, User, Trash2, ChevronLeft, ChevronRight, ChevronDown, Scissors, Paperclip, AlertCircle, X } from 'lucide-react';
import { ModelIcon } from '@lobehub/icons';
import { getConvIcon } from '@/lib/convIcon';
import Bubble from '@ant-design/x/es/bubble';
import Prompts from '@ant-design/x/es/prompts';
import Actions from '@ant-design/x/es/actions';
import Think from '@ant-design/x/es/think';
import type { BubbleItemType, BubbleListRef, RoleType } from '@ant-design/x/es/bubble/interface';
import type { PromptsItemType } from '@ant-design/x/es/prompts';
import NodeRenderer, { setCustomComponents, type NodeComponentProps } from 'markstream-react';
import { useTranslation } from 'react-i18next';
import { useConversationStore, useProviderStore, useSettingsStore } from '@/stores';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { useResolvedDarkMode } from '@/hooks/useResolvedDarkMode';
import { InputArea } from './InputArea';
import { ModelSelector } from './ModelSelector';
import { parseSearchContent } from '@/lib/searchUtils';
import { CHAT_CUSTOM_HTML_TAGS, parseChatMarkdown, type ChatMarkdownNode } from '@/lib/chatMarkdown';
import { WebSearchNode } from './WebSearchNode';
import { McpContainerNode } from './McpContainerNode';
import { getDistanceToHistoryTop, shouldShowScrollToBottom } from './chatScroll';
import { getStreamingLoadingState } from './chatStreaming';
import { buildAssistantDisplayContent, shouldHideAssistantBubble } from './toolCallDisplay';

import { invoke } from '@/lib/invoke';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import type { Message, Attachment } from '@/types';

// ── markstream-react custom thinking component ──────────────────────────

const THINKING_LOADING_MARKER = '<!--aqbot-thinking-loading-->';
const LIGHT_CODE_BLOCK_THEME = 'github-light';
const DEFAULT_DARK_CODE_BLOCK_THEME = 'github-dark';
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
  maxLiveNodes: 160,
  liveNodeBuffer: 24,
} as const;

// ── Attachment preview component ────────────────────────────────────────

const ATTACHMENT_IMG_STYLE: React.CSSProperties = {
  maxWidth: 200,
  maxHeight: 160,
  borderRadius: 8,
  objectFit: 'cover' as const,
};

function AttachmentPreview({ att, themeColor }: { att: Attachment; themeColor: string }) {
  const { t } = useTranslation();
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
          Modal.confirm({
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
          Modal.error({
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

function getChatCodeThemes(selectedDarkTheme?: string) {
  const rawTheme = selectedDarkTheme?.trim();
  const normalizedTheme = rawTheme === 'vs-code' || rawTheme === 'vscode'
    ? 'dark-plus'
    : rawTheme === 'one-dark'
      ? 'one-dark-pro'
      : rawTheme;
  const darkTheme = normalizedTheme || DEFAULT_DARK_CODE_BLOCK_THEME;
  return {
    darkTheme,
    themes: Array.from(new Set([LIGHT_CODE_BLOCK_THEME, darkTheme])),
  };
}

function getChatCodeBlockProps(darkTheme: string) {
  return {
    darkTheme,
    lightTheme: LIGHT_CODE_BLOCK_THEME,
  };
}

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

function ThinkingNode(props: NodeComponentProps<{
  type: 'thinking';
  content: string;
  attrs?: CustomNodeAttrs;
}>) {
  const { t } = useTranslation();
  const selectedDarkCodeTheme = useSettingsStore((s) => s.settings.code_theme);
  const { node, ctx } = props;
  const thinkingNodesCacheRef = useRef<Map<string, ChatMarkdownNode[]>>(new Map());
  const rawThinkingContent = String(node.content ?? '');
  const isStreaming = rawThinkingContent.includes(THINKING_LOADING_MARKER);
  const messageId = getCustomAttr(node.attrs, 'data-message-id') ?? '';
  const thinkingContent = rawThinkingContent
    .replace(`${THINKING_LOADING_MARKER}\n`, '')
    .replace(THINKING_LOADING_MARKER, '');
  const [expanded, setExpanded] = useState(isStreaming);
  const prevStreamingRef = useRef(isStreaming);

  useEffect(() => {
    setExpanded(isStreaming);
    prevStreamingRef.current = isStreaming;
  }, [messageId, isStreaming]);

  useEffect(() => {
    if (isStreaming) {
      setExpanded(true);
    } else if (prevStreamingRef.current) {
      setExpanded(false);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

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
  const { darkTheme, themes } = useMemo(
    () => getChatCodeThemes(selectedDarkCodeTheme),
    [selectedDarkCodeTheme],
  );
  const codeBlockProps = useMemo(
    () => getChatCodeBlockProps(darkTheme),
    [darkTheme],
  );
  const rendererKey = `${ctx?.customId ?? 'default'}:${ctx?.isDark ? 'dark' : 'light'}:${darkTheme}`;

  return (
    <Think
      title={isStreaming ? t('chat.thinkingInProgress', '思考中') : t('chat.thinkingComplete', '思考完成')}
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
        codeBlockLightTheme={LIGHT_CODE_BLOCK_THEME}
        codeBlockDarkTheme={darkTheme}
        codeBlockProps={codeBlockProps}
        customHtmlTags={CHAT_CUSTOM_HTML_TAGS}
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [svgMarkup, setSvgMarkup] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [canRenderPreview, setCanRenderPreview] = useState(false);

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

  const handleCopy = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }

    await navigator.clipboard.writeText(node.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1000);
  }, [node.code]);

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

  const toggleStyle = useMemo(() => ({
    background: isDark ? token.colorFillSecondary : token.colorFillTertiary,
  }), [isDark, token.colorFillSecondary, token.colorFillTertiary]);

  const previewStyle = useMemo(() => ({
    background: isDark ? token.colorBgContainer : token.colorBgElevated,
  }), [isDark, token.colorBgContainer, token.colorBgElevated]);

  return (
    <div ref={containerRef} className="d2-block my-4 rounded-lg border overflow-hidden shadow-sm" style={shellStyle}>
      <div
        className="d2-block-header flex justify-between items-center px-4 py-2.5 border-b border-gray-400/5"
        style={headerStyle}
      >
        <div className="flex items-center gap-x-2">
          <span className="text-sm font-medium font-mono">D2</span>
        </div>
        <div className="flex items-center gap-x-2">
          <div className="flex items-center gap-x-1 rounded-md p-0.5" style={toggleStyle}>
            <button type="button" className={`mode-btn px-2 py-1 text-xs rounded ${!showSource ? 'is-active' : ''}`} onClick={() => setShowSource(false)}>
              预览
            </button>
            <button type="button" className={`mode-btn px-2 py-1 text-xs rounded ${showSource ? 'is-active' : ''}`} onClick={() => setShowSource(true)}>
              源码
            </button>
          </div>
          <button type="button" className="d2-action-btn p-2 text-xs rounded-md transition-colors hover:bg-[var(--vscode-editor-selectionBackground)]" aria-label={copied ? 'Copied' : 'Copy'} onClick={() => void handleCopy()}>
            <Copy size={14} />
          </button>
          {svgMarkup ? (
            <button type="button" className="d2-action-btn p-2 text-xs rounded-md transition-colors hover:bg-[var(--vscode-editor-selectionBackground)]" aria-label="Export" onClick={handleExport}>
              <Share2 size={14} />
            </button>
          ) : null}
        </div>
      </div>

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
                <span className="text-sm">{canRenderPreview ? '正在渲染图表…' : '图表即将渲染…'}</span>
              </div>
            )}
            {error ? <p className="d2-error px-4 pb-3 text-xs">{error}</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatD2Node(props: NodeComponentProps<ChatD2CodeBlockNode>) {
  const { node, ctx } = props;
  return <ChatD2BlockNode node={node} isDark={ctx?.isDark} />;
}

setCustomComponents('chat', { thinking: ThinkingNode, 'web-search': WebSearchNode, d2: ChatD2Node, vmr_container: McpContainerNode });

const AssistantMarkdown = React.memo(function AssistantMarkdown({
  content,
  nodes,
  isDarkMode,
  isStreaming,
  codeBlockDarkTheme,
  codeBlockThemes,
}: {
  content: string;
  nodes?: ChatMarkdownNode[];
  isDarkMode: boolean;
  isStreaming: boolean;
  codeBlockDarkTheme: string;
  codeBlockThemes: string[];
}) {
  const { token } = theme.useToken();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const codeBlockProps = useMemo(
    () => getChatCodeBlockProps(codeBlockDarkTheme),
    [codeBlockDarkTheme],
  );
  const singleD2Node = useMemo(() => getSingleD2CodeBlockNode(nodes), [nodes]);
  const hasDeferredHeavyNodes = useMemo(
    () => containsDeferredHeavyNode(nodes) || content.includes('```'),
    [content, nodes],
  );
  const [readyToRenderHeavyNodes, setReadyToRenderHeavyNodes] = useState(!hasDeferredHeavyNodes);
  const rendererKey = `${isDarkMode ? 'dark' : 'light'}:${codeBlockDarkTheme}`;

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
          <span className="text-sm">正在加载渲染内容…</span>
        </div>
      </div>
    );
  }

  return (
    nodes ? (
      <NodeRenderer
        key={rendererKey}
        nodes={nodes}
        isDark={isDarkMode}
        customId="chat"
        customHtmlTags={CHAT_CUSTOM_HTML_TAGS}
        final={!isStreaming}
        typewriter={isStreaming}
        themes={codeBlockThemes}
        codeBlockLightTheme={LIGHT_CODE_BLOCK_THEME}
        codeBlockDarkTheme={codeBlockDarkTheme}
        codeBlockProps={codeBlockProps}
        {...CHAT_RENDER_BATCH_PROPS}
      />
    ) : (
      <NodeRenderer
        key={rendererKey}
        content={content}
        isDark={isDarkMode}
        customId="chat"
        customHtmlTags={CHAT_CUSTOM_HTML_TAGS}
        final={!isStreaming}
        typewriter={isStreaming}
        themes={codeBlockThemes}
        codeBlockLightTheme={LIGHT_CODE_BLOCK_THEME}
        codeBlockDarkTheme={codeBlockDarkTheme}
        codeBlockProps={codeBlockProps}
        {...CHAT_RENDER_BATCH_PROPS}
      />
    )
  );
}, (prev, next) => (
  prev.content === next.content
  && prev.nodes === next.nodes
  && prev.isDarkMode === next.isDarkMode
  && prev.isStreaming === next.isStreaming
  && prev.codeBlockDarkTheme === next.codeBlockDarkTheme
  && prev.codeBlockThemes === next.codeBlockThemes
));

// ── Version pagination component for multi-version AI replies ──────────

function VersionPagination({
  msg,
  conversationId,
}: {
  msg: Message;
  conversationId: string;
}) {
  const { token } = theme.useToken();
  const [versions, setVersions] = useState<Message[]>([]);
  const listMessageVersions = useConversationStore((s) => s.listMessageVersions);
  const switchMessageVersion = useConversationStore((s) => s.switchMessageVersion);

  useEffect(() => {
    if (msg.parent_message_id && conversationId) {
      listMessageVersions(conversationId, msg.parent_message_id).then((v) => {
        if (v && v.length > 1) setVersions(v);
      });
    }
  }, [msg.parent_message_id, conversationId, listMessageVersions]);

  if (versions.length <= 1) return null;

  const sorted = [...versions].sort((a, b) => a.version_index - b.version_index);
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

// ── Export helpers ──────────────────────────────────────────────────────

import { exportAsPNG, exportAsMarkdown, exportAsJSON, exportAsText } from '@/lib/exportChat';

// ── Component ──────────────────────────────────────────────────────────

export function ChatView() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message: messageApi } = App.useApp();

  // ── Store selectors ────────────────────────────────────────────────
  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const messages = useConversationStore((s) => s.messages);
  const loading = useConversationStore((s) => s.loading);
  const loadingOlder = useConversationStore((s) => s.loadingOlder);
  const hasOlderMessages = useConversationStore((s) => s.hasOlderMessages);
  const streaming = useConversationStore((s) => s.streaming);
  const streamingMessageId = useConversationStore((s) => s.streamingMessageId);
  const thinkingActiveMessageId = useConversationStore((s) => s.thinkingActiveMessageId);
  const storeError = useConversationStore((s) => s.error);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const loadOlderMessages = useConversationStore((s) => s.loadOlderMessages);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const regenerateMessage = useConversationStore((s) => s.regenerateMessage);
  const deleteMessage = useConversationStore((s) => s.deleteMessage);
  const deleteMessageGroup = useConversationStore((s) => s.deleteMessageGroup);
  const removeContextClear = useConversationStore((s) => s.removeContextClear);
  const createConversation = useConversationStore((s) => s.createConversation);
  const providers = useProviderStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const bubbleStyle = settings.bubble_style;
  const profile = useUserProfileStore((s) => s.profile);
  const resolvedAvatarSrc = useResolvedAvatarSrc(profile.avatarType, profile.avatarValue);
  const isDarkMode = useResolvedDarkMode(settings.theme_mode);
  const { darkTheme: codeBlockDarkTheme, themes: codeBlockThemes } = useMemo(
    () => getChatCodeThemes(settings.code_theme),
    [settings.code_theme],
  );

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

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
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<InputRef>(null);
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const bubbleListRef = useRef<BubbleListRef | null>(null);
  const pendingScrollConversationIdRef = useRef<string | null>(activeConversationId ?? null);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [editingTitle]);

  useEffect(() => {
    pendingScrollConversationIdRef.current = activeConversationId ?? null;
    setShowScrollToBottom(false);
  }, [activeConversationId]);

  // Show store errors as notifications
  useEffect(() => {
    if (storeError) {
      messageApi.error(storeError);
      useConversationStore.setState({ error: null });
    }
  }, [storeError, messageApi]);

  const handleTitleClick = useCallback(() => {
    if (!activeConversation) return;
    setTitleDraft(activeConversation.title);
    setEditingTitle(true);
  }, [activeConversation]);

  const handleTitleSave = useCallback(async () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (!trimmed || !activeConversation || trimmed === activeConversation.title) return;
    await updateConversation(activeConversation.id, { title: trimmed });
  }, [titleDraft, activeConversation, updateConversation]);

  const handleLoadOlderMessages = useCallback(async () => {
    const scrollContainer = bubbleListRef.current?.scrollBoxNativeElement as HTMLDivElement | null | undefined;
    const previousScrollHeight = scrollContainer?.scrollHeight ?? 0;
    const previousScrollTop = scrollContainer?.scrollTop ?? 0;
    await loadOlderMessages();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!scrollContainer) return;
        const heightDelta = scrollContainer.scrollHeight - previousScrollHeight;
        scrollContainer.scrollTop = previousScrollTop + Math.max(0, heightDelta);
      });
    });
  }, [loadOlderMessages]);

  const handleBubbleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setShowScrollToBottom(shouldShowScrollToBottom(event.currentTarget.scrollTop));
    if (!hasOlderMessages || loading || loadingOlder) return;
    const target = event.currentTarget;
    const distanceToHistoryTop = getDistanceToHistoryTop(target.scrollHeight, target.scrollTop, target.clientHeight);
    if (distanceToHistoryTop > 24) return;
    void handleLoadOlderMessages();
  }, [handleLoadOlderMessages, hasOlderMessages, loading, loadingOlder]);

  const handleScrollToBottom = useCallback(() => {
    bubbleListRef.current?.scrollTo({ top: 'bottom', behavior: 'smooth' });
    setShowScrollToBottom(false);
  }, []);

  // ── Export menu ────────────────────────────────────────────────────
  const exportMenuItems = useMemo(
    () => [
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

        await sendMessage(text);
      } catch (e) {
        console.error('[handlePromptClick] error:', e);
        messageApi.error(String(e));
      }
    },
    [activeConversationId, providers, settings, createConversation, sendMessage, messageApi, t],
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
      if (msg.role === 'assistant' && !aiContent.startsWith('<web-search')) {
        const parentSearch = msg.parent_message_id
          ? userSearchContentById.get(msg.parent_message_id)
          : undefined;
        if (parentSearch?.hasSearch && parentSearch.sources.length > 0) {
          const { sources } = parentSearch;
          const resultsJson = JSON.stringify(sources.map((s) => ({ title: s.title, url: s.url })));
          aiContent = `<web-search status="done">\n${resultsJson}\n</web-search>\n\n${aiContent}`;
        }
      }
      if (msg.role === 'assistant' && msg.thinking) {
        const thinkingMarker = thinkingActiveMessageId === msg.id
          ? `${THINKING_LOADING_MARKER}\n`
          : '';
        aiContent = `<thinking data-message-id="${msg.id}">${thinkingMarker}${msg.thinking}</thinking>\n\n${aiContent}`;
      }

      const signature = `ai:${aiContent}`;
      const cached = cache.get(msg.id);
      const item = cached?.signature === signature
        ? cached.item
        : { key: msg.id, role: 'ai', content: aiContent };
      nextCache.set(msg.id, { signature, item });
      nextItems.push(item);
    }

    bubbleItemCacheRef.current = nextCache;
    return nextItems;
  }, [activeMessages, thinkingActiveMessageId, userSearchContentById]);
  const lastBubbleKey = bubbleItems.length > 0
    ? String(bubbleItems[bubbleItems.length - 1].key)
    : '';

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
      if (item.role !== 'ai' || typeof item.content !== 'string' || item.content.startsWith('%%ERROR%%')) {
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
  }, [bubbleItems]);
  // ── Format timestamp ──────────────────────────────────────────────
  const formatTime = useCallback((ts: number) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, []);

  // ── Resolve model name for the conversation ──────────────────────
  const getModelDisplayName = useCallback((modelId?: string | null, providerId?: string | null) => {
    const mid = modelId ?? activeConversation?.model_id;
    const pid = providerId ?? activeConversation?.provider_id;
    if (!mid) return 'AI';
    const provider = providers.find((p) => p.id === pid);
    const model = provider?.models.find((m) => m.model_id === mid);
    return model?.name ?? mid;
  }, [activeConversation, providers]);

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
              {content && <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>}
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
        : undefined,
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
              icon: <Copy size={14} />,
              label: t('chat.copy'),
              onItemClick: () => {
                navigator.clipboard
                  .writeText(String(bubbleData.content ?? ''))
                  .then(() => messageApi.success(t('chat.copied')));
              },
            },
            {
              key: 'regenerate',
              icon: <RotateCcw size={14} />,
              label: t('chat.regenerate'),
              onItemClick: async () => {
                try {
                  await regenerateMessage();
                } catch (e) {
                  messageApi.error(String(e));
                }
              },
            },
            {
              key: 'delete',
              actionRender: () => (
                <Popconfirm
                  title={t('chat.confirmDeleteMessage', '确定删除这条消息及其所有回复吗？')}
                  onConfirm={async () => {
                    if (msg && activeConversationId) {
                      try {
                        await deleteMessageGroup(activeConversationId, msg.id);
                      } catch (e) {
                        messageApi.error(String(e));
                      }
                    }
                  }}
                  okText={t('common.confirm', '确定')}
                  cancelText={t('common.cancel', '取消')}
                >
                  <span style={{ cursor: 'pointer', color: token.colorError, display: 'inline-flex', alignItems: 'center', padding: '0 4px' }}>
                    <Trash2 size={14} />
                  </span>
                </Popconfirm>
              ),
            },
          ]}
        />
      ),
    };
  }, [activeConversationId, deleteMessageGroup, formatTime, getBubbleVariant, messageApi, messageById, profile.name, regenerateMessage, t, token.colorError, token.colorPrimary, userAvatar]);

  const aiRole = useCallback((bubbleData: BubbleItemType) => {
    const msg = messageById.get(String(bubbleData.key));
    const isStreaming = streaming && bubbleData.key === streamingMessageId;
    const assistantCopyText = msg?.content ?? (typeof bubbleData.content === 'string' ? bubbleData.content : '');
    const parsedNodes = aiContentNodesById.get(String(bubbleData.key));
    const { bubbleLoading, footerLoading } = getStreamingLoadingState(isStreaming, bubbleData.content);
    return {
      placement: 'start' as const,
      ...getBubbleVariant(false),
      avatar: renderConvIconForChat(32, msg?.model_id),
      loading: bubbleLoading,
      contentRender: (content: string) => {
        if (typeof content === 'string' && content.startsWith('%%ERROR%%')) {
          return <Alert type="error" message={content.replace('%%ERROR%%', '')} showIcon />;
        }
        return (
          <AssistantMarkdown
            content={content}
            nodes={parsedNodes}
            isDarkMode={isDarkMode}
            isStreaming={isStreaming}
            codeBlockDarkTheme={codeBlockDarkTheme}
            codeBlockThemes={codeBlockThemes}
          />
        );
      },
      header: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Typography.Text style={{ fontSize: 13 }}>
              {getModelDisplayName(msg?.model_id, msg?.provider_id)}
            </Typography.Text>
            {msg && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {formatTime(msg.created_at)}
              </Typography.Text>
            )}
          </div>
        </div>
      ),
      footer: footerLoading ? (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            color: token.colorPrimary,
          }}
          aria-label={t('chat.generating', '生成中…')}
        >
          <span className="aqbot-streaming-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {msg && activeConversationId && (
            <VersionPagination msg={msg} conversationId={activeConversationId} />
          )}
          <Actions
            items={[
              {
                key: 'copy',
                icon: <Copy size={14} />,
                label: t('chat.copy'),
                onItemClick: () => {
                  const text = assistantCopyText.startsWith('%%ERROR%%')
                    ? assistantCopyText.replace('%%ERROR%%', '')
                    : assistantCopyText;
                  navigator.clipboard
                    .writeText(text)
                    .then(() => messageApi.success(t('chat.copied')));
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
                    title={t('chat.confirmDeleteMessage', '确定删除这条回复吗？')}
                    onConfirm={async () => {
                      if (msg) {
                        try {
                          await deleteMessage(msg.id);
                        } catch (e) {
                          messageApi.error(String(e));
                        }
                      }
                    }}
                    okText={t('common.confirm', '确定')}
                    cancelText={t('common.cancel', '取消')}
                  >
                    <span style={{ cursor: 'pointer', color: token.colorError, display: 'inline-flex', alignItems: 'center', padding: '0 4px' }}>
                      <Trash2 size={14} />
                    </span>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </div>
      ),
    };
  }, [activeConversationId, aiContentNodesById, codeBlockDarkTheme, codeBlockThemes, deleteMessage, formatTime, getBubbleVariant, getModelDisplayName, isDarkMode, messageApi, messageById, regenerateMessage, renderConvIconForChat, streaming, streamingMessageId, t, token.colorError, token.colorPrimary]);

  const contextClearRole = useCallback((bubbleData: BubbleItemType) => {
    const msgId = String(bubbleData.content ?? '');
    return {
      placement: 'start' as const,
      variant: 'borderless' as const,
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
            <Scissors size={14} style={{ marginRight: 4 }} /> {t('chat.contextCleared', '上下文已从此处重置')}
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

  const roles: RoleType = useMemo(() => ({
    user: userRole,
    ai: aiRole,
    'context-clear': contextClearRole,
  }), [aiRole, contextClearRole, userRole]);

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
              <Input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={handleTitleSave}
                onPressEnter={handleTitleSave}
                size="small"
                style={{ maxWidth: 240 }}
              />
            ) : (
              <Typography.Text
                className="cursor-pointer select-none"
                onClick={handleTitleClick}
              >
                {activeConversation.title} <Pencil size={12} className="text-xs opacity-50" />
              </Typography.Text>
            )}

            <div className="flex-1" />

            <ModelSelector />
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
      <div ref={messageAreaRef} data-message-area className={`flex-1 min-h-0 overflow-hidden bubble-${bubbleStyle || 'modern'}`}>
        {messages.length === 0 ? (
          activeConversationId && loading ? (
            <div
              className="flex flex-col items-center justify-center h-full"
              style={{ gap: 12, padding: '0 24px', color: token.colorTextSecondary }}
            >
              <SyncOutlined spin style={{ fontSize: 20, color: token.colorPrimary }} />
              <Typography.Text type="secondary">
                {t('chat.loadingConversation', '正在加载对话内容…')}
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
          <Bubble.List
            ref={bubbleListRef}
            items={bubbleItems}
            autoScroll
            onScroll={handleBubbleListScroll}
            role={roles}
            style={{ height: '100%', padding: '16px 24px', overflowX: 'hidden' }}
          />
        )}
      </div>

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
            {t('chat.scrollToBottom', '回到底部')}
          </Button>
        )}
        <InputArea />
      </div>
    </div>
  );
}
