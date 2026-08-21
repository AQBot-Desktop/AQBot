import { usePageSuspendCleanup } from '@/components/layout/PageLifecycle';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { useResolvedAvatarSrc } from '@/hooks/useResolvedAvatarSrc';
import { useResolvedDarkMode } from '@/hooks/useResolvedDarkMode';
import { safeParseChatMarkdown, shouldUsePlainTextChatContent, type ChatMarkdownNode } from '@/lib/chatMarkdown';
import { createChatContentFingerprint, getCachedChatMarkdown, setCachedChatMarkdown } from '@/lib/chatMarkdownCache';
import {
  getMessageVersionGroupKey,
  hasMultipleModelVersions,
  resolvePendingDisplayVersionSelection,
  selectRenderableVersionSet,
  shouldRenderStandaloneAssistantError,
  type PendingDisplayVersionSelection,
} from '@/lib/chatMultiModel';
import { getConvIcon } from '@/lib/convIcon';
import { normalizeAutoConversationTitle } from '@/lib/conversationTitle';
import { invoke } from '@/lib/invoke';
import { perfNow, perfTraceDuration } from '@/lib/perfTrace';
import { getRoleIntro } from '@/lib/roleIntro';
import { parseSearchContent } from '@/lib/searchUtils';
import { normalizeStoredMediaUrlsForPlatform } from '@/lib/storedMedia';
import { useAgentStore, useConversationStore, useProviderStore, useSettingsStore } from '@/stores';
import { MAX_LOADED_MESSAGES } from '@/stores/conversationStore';
import { useUserProfileStore, type AvatarType } from '@/stores/userProfileStore';
import type { ConversationStats, ConversationSummary, Message } from '@/types';
import { SyncOutlined } from '@ant-design/icons';
import Actions from '@ant-design/x/es/actions';
import Bubble from '@ant-design/x/es/bubble';
import type { BubbleItemType, BubbleListRef, RoleType } from '@ant-design/x/es/bubble/interface';
import type { PromptsItemType } from '@ant-design/x/es/prompts';
import Prompts from '@ant-design/x/es/prompts';
import type { InputRef } from 'antd';
import {
  Alert,
  App,
  Avatar,
  Button,
  Checkbox,
  Dropdown,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import {
  Bot,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  Code,
  Copy,
  FileCode,
  FileImage,
  Languages,
  Lightbulb,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RotateCcw,
  Scissors,
  Share2,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import NodeRenderer, { type CodeBlockPreviewPayload } from 'markstream-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { registerHighlight } from 'stream-markdown';
import AskUserCard from './AskUserCard';
import { ChatMessageRenderBoundary } from './ChatMessageRenderBoundary';
import { ChatMinimap, MinimapScrollProvider } from './ChatMinimap';
import { ChatScrollIndicator } from './ChatScrollIndicator';
import { CodeBlockPreviewModal } from './CodeBlockPreviewModal';
import { ConversationModelIcon } from './ConversationModelIcon';
import { InputArea } from './InputArea';
import { MessageAttachmentPreview } from './MessageAttachmentPreview';
import { ModelSelector } from './ModelSelector';
import { MultiModelDisplay, type MultiModelDisplayMode } from './MultiModelDisplay';
import PermissionCard from './PermissionCard';
import { getChatCodeThemes, setCodeBlockPreviewHandler, setMermaidOpenModalHandler } from './chatMarkdownShared';
import { resolveAssistantMessageForBubbleKey } from './chatMessageLookup';
import { collectRetainedChatCacheKeys, retainMapKeys, retainSetValues } from './chatRetainedCaches';
import {
  CHAT_AUTO_SCROLL_BOTTOM_THRESHOLD,
  CHAT_SCROLL_IS_REVERSED,
  captureMessageScrollAnchor,
  getDistanceToHistoryTop,
  hasMeasuredScrollLayoutChanged,
  hasScrollLayoutMetricsChanged,
  resolveChatScrollElements,
  restoreMessageScrollAnchor,
  shouldIgnoreScrollDepartureFromBottom,
  shouldKeepAutoScroll,
  shouldShowScrollToBottom,
  shouldStickToBottomOnLayoutChange,
} from './chatScroll';
import {
  closeStreamingThinkBlock,
  getStreamingLoadingState,
  getStreamingStatusPresentation,
  hasAqbotDisplayContent,
  hasModelVisibleContent,
  isAssistantStreamingForRender,
  shouldRenderAssistantMarkdownFromContent,
  shouldShowInitialStreamingDots,
  shouldShowInlineStreamingStatus,
  type StreamActivity,
} from './chatStreaming';
import { formatChatTime } from './chatTime';
import {
  buildAssistantDisplayContent,
  shouldHideAssistantBubble,
  splitAssistantErrorDisplayContent,
} from './toolCallDisplay';

import { AssistantFooter, StatsPopoverContent, findLatestLocalGeneratedVersion } from './ChatAssistantFooter';
import {
  AssistantMarkdown,
  MessageRenderFallback,
  MINIMAP_JUMP_AFTER_LIMIT,
  MINIMAP_JUMP_BEFORE_LIMIT,
  PlainTextChatContent,
  StreamingAssistantContent,
  USER_SCROLL_INTENT_GRACE_MS,
  shouldDeferAssistantMarkdownParse,
  stripAssistantAqbotTags,
  stripUserAqbotTags,
} from './ChatAssistantMarkdown';

import { useChatShareExport } from './useChatShareExport';
import { useChatBubblePresentation } from './useChatBubblePresentation';

// ── Component ──────────────────────────────────────────────────────────

export function ChatView() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message: messageApi } = App.useApp();
  const pageActiveRef = useRef(true);
  const pageConnectionGenerationRef = useRef(0);

  useEffect(() => {
    pageConnectionGenerationRef.current += 1;
    pageActiveRef.current = true;
    return () => {
      pageActiveRef.current = false;
      pageConnectionGenerationRef.current += 1;
    };
  }, []);

  // ── Store selectors ────────────────────────────────────────────────
  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const messages = useConversationStore((s) => s.messages);
  const ragDisplayByMessageId = useConversationStore((s) => s.ragDisplayByMessageId);
  const searchDisplayByMessageId = useConversationStore((s) => s.searchDisplayByMessageId);
  const loading = useConversationStore((s) => s.loading);
  const showingPreviousConversationWindow = Boolean(
    loading
    && activeConversationId
    && messages.length > 0
    && messages.some((message) => message.conversation_id !== activeConversationId),
  );
  const loadingOlder = useConversationStore((s) => s.loadingOlder);
  const loadingNewer = useConversationStore((s) => s.loadingNewer);
  const hasOlderMessages = useConversationStore((s) => s.hasOlderMessages);
  const hasNewerMessages = useConversationStore((s) => s.hasNewerMessages);
  const streaming = useConversationStore((s) => s.streaming);
  const compressingConversationId = useConversationStore((s) => s.compressingConversationId);
  const streamingMessageId = useConversationStore((s) => s.streamingMessageId);
  const streamActivityByMessageId = useConversationStore((s) => s.streamActivityByMessageId);
  const multiModelParentId = useConversationStore((s) => s.multiModelParentId);
  const multiModelDoneMessageIds = useConversationStore((s) => s.multiModelDoneMessageIds);
  const thinkingActiveMessageIds = useConversationStore((s) => s.thinkingActiveMessageIds);
  const storeError = useConversationStore((s) => s.error);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const titleGeneratingConversationId = useConversationStore((s) => s.titleGeneratingConversationId);
  const regenerateTitle = useConversationStore((s) => s.regenerateTitle);
  const loadOlderMessages = useConversationStore((s) => s.loadOlderMessages);
  const loadNewerMessages = useConversationStore((s) => s.loadNewerMessages);
  const loadMessagesAround = useConversationStore((s) => s.loadMessagesAround);
  const regenerateMessage = useConversationStore((s) => s.regenerateMessage);
  const regenerateWithModel = useConversationStore((s) => s.regenerateWithModel);
  const deleteMessage = useConversationStore((s) => s.deleteMessage);
  const deleteMessageGroup = useConversationStore((s) => s.deleteMessageGroup);
  const switchMessageVersion = useConversationStore((s) => s.switchMessageVersion);
  const updateMessageContent = useConversationStore((s) => s.updateMessageContent);
  const branchConversation = useConversationStore((s) => s.branchConversation);
  const removeContextClear = useConversationStore((s) => s.removeContextClear);
  const getCompressionSummary = useConversationStore((s) => s.getCompressionSummary);
  const retryCompression = useConversationStore((s) => s.retryCompression);
  const deleteCompression = useConversationStore((s) => s.deleteCompression);
  const openCompressionSummaryToken = useConversationStore((s) => s.openCompressionSummaryToken);
  const listMessageVersionsBatch = useConversationStore((s) => s.listMessageVersionsBatch);
  const hydrateMessageVersions = useConversationStore((s) => s.hydrateMessageVersions);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [summaryModalText, setSummaryModalText] = useState('');
  const [summaryModalSummary, setSummaryModalSummary] = useState<ConversationSummary | null>(null);
  const [summaryModalTab, setSummaryModalTab] = useState<'summary' | 'source'>('summary');
  const [summaryRetrying, setSummaryRetrying] = useState(false);
  const [previewPayload, setPreviewPayload] = useState<CodeBlockPreviewPayload | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [mermaidPreviewSvg, setMermaidPreviewSvg] = useState<string | null>(null);
  const [mermaidPreviewOpen, setMermaidPreviewOpen] = useState(false);
  const [streamStatusNow, setStreamStatusNow] = useState(() => Date.now());
  const createConversation = useConversationStore((s) => s.createConversation);
  const providers = useProviderStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const bubbleStyle = settings.bubble_style;
  const chatSidebarCollapsed = settings.chat_sidebar_collapsed ?? false;
  const profile = useUserProfileStore((s) => s.profile);
  const resolvedAvatarSrc = useResolvedAvatarSrc(profile.avatarType, profile.avatarValue);
  const isDarkMode = useResolvedDarkMode(settings.theme_mode);
  const { copy: copyMessage, isCopiedFor: isUserMsgCopied } = useCopyToClipboard();
  const { darkTheme: codeBlockDarkTheme, lightTheme: codeBlockLightTheme, themes: codeBlockThemes } = useMemo(
    () => getChatCodeThemes(settings.code_theme, settings.code_theme_light),
    [settings.code_theme, settings.code_theme_light],
  );
  const bubbleListThemeKey = `bubble-list:${isDarkMode ? 'dark' : 'light'}:${settings.code_theme ?? ''}:${settings.code_theme_light ?? ''}`;
  const userMessageAreaStyle = settings.chat_user_message_area_style ?? 'none';
  const aiMessageAreaStyle = settings.chat_ai_message_area_style ?? 'none';
  const userMessageAreaBorderWidth = Math.min(4, Math.max(1, Math.round(settings.chat_user_message_area_border_width ?? 1)));
  const aiMessageAreaBorderWidth = Math.min(4, Math.max(1, Math.round(settings.chat_ai_message_area_border_width ?? 1)));
  const userMessageAreaClass = userMessageAreaStyle === 'background'
    ? ' bubble-user-background'
    : userMessageAreaStyle === 'border'
      ? ' bubble-user-border'
      : '';
  const aiMessageAreaClass = aiMessageAreaStyle === 'background'
    ? ' bubble-ai-background'
    : aiMessageAreaStyle === 'border'
      ? ' bubble-ai-border'
      : '';
  const messageAreaStyle = useMemo(() => ({
    '--chat-user-message-area-color': isDarkMode
      ? settings.chat_user_message_area_dark_color
      : settings.chat_user_message_area_light_color,
    '--chat-user-message-area-border-width': `${userMessageAreaBorderWidth}px`,
    '--chat-ai-message-area-color': isDarkMode
      ? settings.chat_ai_message_area_dark_color
      : settings.chat_ai_message_area_light_color,
    '--chat-ai-message-area-border-width': `${aiMessageAreaBorderWidth}px`,
  }) as React.CSSProperties, [
    aiMessageAreaBorderWidth,
    isDarkMode,
    settings.chat_ai_message_area_dark_color,
    settings.chat_ai_message_area_light_color,
    settings.chat_user_message_area_dark_color,
    settings.chat_user_message_area_light_color,
    userMessageAreaBorderWidth,
  ]);

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
    setCodeBlockPreviewHandler((payload: CodeBlockPreviewPayload) => {
      setPreviewPayload(payload);
      setPreviewModalOpen(true);
    });
    return () => { setCodeBlockPreviewHandler(null); };
  }, []);

  // Register module-level preview handler for mermaid
  useEffect(() => {
    setMermaidOpenModalHandler((svgString: string | null) => {
      setMermaidPreviewSvg(svgString);
      setMermaidPreviewOpen(true);
    });
    return () => { setMermaidOpenModalHandler(null); };
  }, []);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  useEffect(() => {
    const agentStore = useAgentStore.getState();
    const visibleAgentConversationId = activeConversation?.mode === 'agent'
      ? activeConversationId
      : null;
    agentStore.setVisibleConversation(visibleAgentConversationId);
    return () => {
      if (useAgentStore.getState().visibleConversationId === visibleAgentConversationId) {
        useAgentStore.getState().setVisibleConversation(null);
      }
    };
  }, [activeConversation?.mode, activeConversationId]);
  const activeCustomConvIcon = activeConversation ? getConvIcon(activeConversation.id) : null;
  const resolvedActiveCustomConvIconSrc = useResolvedAvatarSrc(
    (activeCustomConvIcon?.type as AvatarType) ?? 'icon',
    activeCustomConvIcon?.value ?? '',
  );
  const compressing = activeConversationId !== null
    && compressingConversationId === activeConversationId;
  const isTitleGenerating = activeConversationId != null && titleGeneratingConversationId === activeConversationId;
  const summaryBoundaryLabel = useMemo(() => {
    const boundaryId = summaryModalSummary?.compressed_until_message_id;
    if (!boundaryId) return null;
    const boundaryIndex = messages.findIndex((message) => message.id === boundaryId);
    if (boundaryIndex < 0) return boundaryId.slice(0, 8);
    const boundaryMessage = messages[boundaryIndex];
    return `#${boundaryIndex + 1} - ${formatChatTime(boundaryMessage.created_at)}`;
  }, [messages, summaryModalSummary?.compressed_until_message_id]);

  const renderConvIconForChat = useCallback((size: number, modelId?: string | null) => {
    if (!activeConversation) return <Avatar icon={<Bot size={16} />} style={{ background: token.colorPrimary }} size={size} />;
    const customIcon = activeCustomConvIcon;
    if (customIcon) {
      if (customIcon.type === 'emoji') {
        return <Avatar size={size} style={{ fontSize: Math.round(size * 0.5), backgroundColor: token.colorPrimaryBg }}>{customIcon.value}</Avatar>;
      }
      const src = customIcon.type === 'file'
        ? (resolvedActiveCustomConvIconSrc ?? (customIcon.value.startsWith('data:') ? customIcon.value : undefined))
        : customIcon.value;
      return <Avatar size={size} src={src} />;
    }
    const mid = modelId ?? activeConversation.model_id;
    if (mid) {
      return <ConversationModelIcon model={mid} size={size} />;
    }
    return <Avatar icon={<Bot size={16} />} style={{ background: token.colorPrimary }} size={size} />;
  }, [activeConversation, activeCustomConvIcon, resolvedActiveCustomConvIconSrc, token.colorPrimary, token.colorPrimaryBg]);

  const handleChatSidebarToggle = useCallback(() => {
    void saveSettings({ chat_sidebar_collapsed: !chatSidebarCollapsed });
  }, [chatSidebarCollapsed, saveSettings]);

  const renderChatSidebarToggle = useCallback(() => {
    const label = t(chatSidebarCollapsed ? 'chat.expandSidebar' : 'chat.collapseSidebar');
    return (
      <Button
        type="text"
        size="small"
        aria-label={label}
        icon={chatSidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        onClick={handleChatSidebarToggle}
        style={{ flexShrink: 0 }}
      />
    );
  }, [chatSidebarCollapsed, handleChatSidebarToggle, t]);

  const { getBubbleVariant, userAvatar } = useChatBubblePresentation({
    bubbleStyle,
    profile,
    resolvedAvatarSrc,
    token,
  });

  const {
    exitShareSelectMode,
    exportMenuItems,
    exportSelectedShare,
    getShareSelectBubbleStyles,
    handleShareSelectableClick,
    resetShareSelection,
    selectAllShareMessages,
    selectedShareMessageIds,
    shareExporting,
    shareSelectMode,
    toggleShareMessage,
    wrapShareSelectableContent,
  } = useChatShareExport({
    activeConversation,
    activeConversationId,
    hasNewerMessages,
    hasOlderMessages,
    messageApi,
    messages,
    profileName: profile.name,
    providers,
    t,
    token,
  });

  // ── Title editing state ────────────────────────────────────────────
  const [editingTitle, setEditingTitle] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageRole, setEditingMessageRole] = useState<'user' | 'assistant' | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [cardBranchTarget, setCardBranchTarget] = useState<{ messageId: string; asChild: boolean } | null>(null);
  const [cardBranchTitle, setCardBranchTitle] = useState('');
  const [cardBranchSaving, setCardBranchSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  /** Multi-select messages for share/export */
  const titleInputRef = useRef<InputRef>(null);
  const skipTitleSaveRef = useRef(false);

  const openCompressionSummaryModal = useCallback(async () => {
    const convId = activeConversationId;
    if (!convId) return;
    const connectionGeneration = pageConnectionGenerationRef.current;
    const summary = await getCompressionSummary(convId);
    if (
      !pageActiveRef.current
      || pageConnectionGenerationRef.current !== connectionGeneration
      || useConversationStore.getState().activeConversationId !== convId
    ) return;
    setSummaryModalText(summary?.summary_text ?? t('chat.noSummary'));
    setSummaryModalSummary(summary ?? null);
    setSummaryModalTab('summary');
    setSummaryModalOpen(true);
  }, [activeConversationId, getCompressionSummary, t]);

  // InputArea context circle requests opening this modal
  const lastOpenCompressionSummaryTokenRef = useRef(0);
  useEffect(() => {
    if (openCompressionSummaryToken === 0) return;
    if (openCompressionSummaryToken === lastOpenCompressionSummaryTokenRef.current) return;
    lastOpenCompressionSummaryTokenRef.current = openCompressionSummaryToken;
    void openCompressionSummaryModal();
  }, [openCompressionSummaryToken, openCompressionSummaryModal]);

  usePageSuspendCleanup(() => {
    setStatsOpen(false);
    setStats(null);
    setEditingTitle(false);
    setEditingMessageId(null);
    setEditingMessageRole(null);
    setEditingContent('');
    setCardBranchTarget(null);
    setCardBranchTitle('');
    setSummaryModalOpen(false);
    setSummaryModalSummary(null);
    setSummaryModalTab('summary');
    setSummaryRetrying(false);
    setPreviewModalOpen(false);
    setPreviewPayload(null);
    setMermaidPreviewOpen(false);
    setMermaidPreviewSvg(null);
    resetShareSelection();
  });

  // Leave share-select mode when switching conversations
  useEffect(() => {
    exitShareSelectMode();
  }, [activeConversationId, exitShareSelectMode]);

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
  const lastScrollResetConversationIdRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(stickToBottom);
  const scrollLayoutMetricsRef = useRef({ scrollHeight: 0, clientHeight: 0 });
  const visibleMessageAnchorRef = useRef<ReturnType<typeof captureMessageScrollAnchor>>(null);
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
    const scrollToMountedMessage = () => {
      // scrollBoxRef may not be populated yet on first load; fall back to DOM query
      let scrollBox = scrollBoxRef.current;
      if (!scrollBox) {
        scrollBox = (bubbleListRef.current?.scrollBoxNativeElement as HTMLElement)
          ?? document.querySelector<HTMLElement>('.ant-bubble-list-scroll-box');
        if (scrollBox) scrollBoxRef.current = scrollBox;
      }
      if (!scrollBox) return false;
      const marker = scrollBox.querySelector(`[data-aqbot-msg="${messageId}"]`);
      if (!marker) return false;
      // Walk up from marker to find the bubble wrapper (near-child of scrollBox)
      let el: Element = marker;
      for (;;) {
        const parent = el.parentElement;
        if (!parent || parent === scrollBox) break;
        if (parent.parentElement === scrollBox) break;
        el = parent;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    };

    if (scrollToMountedMessage()) return;

    void (async () => {
      await loadMessagesAround(messageId, MINIMAP_JUMP_BEFORE_LIMIT, MINIMAP_JUMP_AFTER_LIMIT);
      if (pageActiveRef.current) window.requestAnimationFrame(scrollToMountedMessage);
    })();
  }, [loadMessagesAround]);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [editingTitle]);

  useEffect(() => {
    if (lastScrollResetConversationIdRef.current === activeConversationId) return;
    lastScrollResetConversationIdRef.current = activeConversationId ?? null;
    pendingScrollConversationIdRef.current = activeConversationId ?? null;
    setShowScrollToBottom(false);
    setStickToBottomState(true);
    scrollLayoutMetricsRef.current = { scrollHeight: 0, clientHeight: 0 };
    visibleMessageAnchorRef.current = null;
    contentRendererMessageIdsRef.current.clear();
  }, [activeConversationId, setStickToBottomState]);

  useEffect(() => {
    if (!streaming || !streamingMessageId) {
      return;
    }
    contentRendererMessageIdsRef.current.add(streamingMessageId);
  }, [streaming, streamingMessageId]);

  useEffect(() => {
    if (!streaming) {
      return;
    }

    setStreamStatusNow(Date.now());
    const timer = window.setInterval(() => setStreamStatusNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

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
      void useAgentStore.getState().ensureToolHistoryLoaded(activeConversationId).catch((error) => {
        console.error('[ChatView] loadToolHistory failed:', error);
      });
    }
  }, [activeConversationId, activeConversation?.mode]);

  // Show store errors as notifications
  useEffect(() => {
    if (storeError) {
      messageApi.error(storeError);
      useConversationStore.setState({ error: null });
    }
  }, [storeError, messageApi]);

  const currentAgentStatus = useAgentStore(
    (s) => (activeConversationId ? s.agentStatus[activeConversationId] : undefined),
  );

  useAgentStore(
    (s) => (activeConversationId ? s.conversationRevisions[activeConversationId] ?? 0 : 0),
  );
  const agentState = useAgentStore.getState();
  const agentToolCalls = agentState.toolCalls;
  const agentPendingPermissions = agentState.pendingPermissions;
  const agentPendingAskUser = agentState.pendingAskUser;

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
    const anchor = scrollContainer ? captureMessageScrollAnchor(scrollContainer) : null;
    await loadOlderMessages();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!scrollContainer || !pageActiveRef.current) return;
        restoreMessageScrollAnchor(scrollContainer, anchor);
        visibleMessageAnchorRef.current = captureMessageScrollAnchor(scrollContainer);
      });
    });
  }, [loadOlderMessages]);

  const handleLoadNewerMessages = useCallback(async () => {
    const scrollContainer = bubbleListRef.current?.scrollBoxNativeElement as HTMLDivElement | null | undefined;
    const anchor = !stickToBottomRef.current && scrollContainer
      ? captureMessageScrollAnchor(scrollContainer)
      : null;
    await loadNewerMessages();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!scrollContainer || !pageActiveRef.current) return;
        if (stickToBottomRef.current) {
          bubbleListRef.current?.scrollTo({ top: 'bottom', behavior: 'auto' });
          return;
        }
        restoreMessageScrollAnchor(scrollContainer, anchor);
        visibleMessageAnchorRef.current = captureMessageScrollAnchor(scrollContainer);
      });
    });
  }, [loadNewerMessages]);

  const handleBubbleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    visibleMessageAnchorRef.current = captureMessageScrollAnchor(target);
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
    if (loading || loadingOlder || loadingNewer) return;
    if (hasNewerMessages && hadRecentUserScrollIntent) {
      const distanceToHistoryBottom = CHAT_SCROLL_IS_REVERSED
        ? Math.abs(target.scrollTop)
        : target.scrollHeight - target.clientHeight - target.scrollTop;
      if (distanceToHistoryBottom <= 24) {
        void handleLoadNewerMessages();
        return;
      }
    }
    if (!hasOlderMessages || !hadRecentUserScrollIntent) return;
    const distanceToHistoryTop = getDistanceToHistoryTop(
      target.scrollHeight,
      target.scrollTop,
      target.clientHeight,
      CHAT_SCROLL_IS_REVERSED,
    );
    if (distanceToHistoryTop > 24) return;
    void handleLoadOlderMessages();
  }, [
    handleLoadNewerMessages,
    handleLoadOlderMessages,
    hasNewerMessages,
    hasOlderMessages,
    loading,
    loadingNewer,
    loadingOlder,
    setStickToBottomState,
  ]);

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
        visibleMessageAnchorRef.current = null;
        setShowScrollToBottom(false);
        return;
      }

      if (!stickToBottomRef.current && visibleMessageAnchorRef.current) {
        restoreMessageScrollAnchor(target, visibleMessageAnchorRef.current);
        visibleMessageAnchorRef.current = captureMessageScrollAnchor(target);
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
      if (scrollLayoutMetricsRef.current.scrollHeight === 0) {
        scrollLayoutMetricsRef.current = {
          scrollHeight: scrollBox.scrollHeight,
          clientHeight: scrollBox.clientHeight,
        };
      }

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
    let timeoutId: number | null = null;
    if (streaming && !prevStreamingRef.current) {
      // Delay to let the new message bubble render before scrolling
      timeoutId = window.setTimeout(() => {
        bubbleListRef.current?.scrollTo({ top: 'bottom', behavior: 'smooth' });
        setShowScrollToBottom(false);
        setStickToBottomState(true);
      }, 50);
    }
    prevStreamingRef.current = streaming;
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [setStickToBottomState, streaming]);

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
          await createConversation(normalizeAutoConversationTitle(text), model.model_id, provider.id);
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

  const roleIntro = useMemo(() => {
    if (!activeConversationId || loading || messages.length > 0 || (activeConversation?.message_count ?? 0) > 0) {
      return null;
    }
    return getRoleIntro(activeConversationId);
  }, [activeConversation?.message_count, activeConversationId, loading, messages.length]);

  const roleIntroPromptItems: PromptsItemType[] = useMemo(
    () => {
      if (!roleIntro) return [];
      return roleIntro.openingQuestions.map((question, index) => ({
        key: `role-intro-${index}`,
        label: question,
      }));
    },
    [roleIntro],
  );

  const handleRoleIntroPromptClick = useCallback((info: { data: PromptsItemType }) => {
    const text = typeof info.data.label === 'string' ? info.data.label : '';
    if (!text) return;
    useConversationStore.getState().setPendingPromptText(text);
  }, []);

  // ── Bubble items (only show active messages) ────────────────────────
  const activeMessages = useMemo(
    () => messages.filter((msg) => msg.is_active !== false),
    [messages],
  );
  const assistantVersionParentIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const msg of activeMessages) {
      if (msg.role === 'assistant' && msg.parent_message_id) {
        ids.add([
          msg.parent_message_id,
          msg.id,
          msg.version_index,
          createChatContentFingerprint(msg.content),
        ].join('\0'));
      }
    }
    return Array.from(ids).join('\n');
  }, [activeMessages]);
  const [messageVersionsByParentId, setMessageVersionsByParentId] = useState<Record<string, Message[]>>({});
  const messageVersionsCacheRef = useRef(new Map<string, Record<string, string[]>>());
  const messageById = useMemo(
    () => new Map(messages.map((msg) => [msg.id, msg])),
    [messages],
  );
  const currentMessageVersionsByParentId = useMemo(() => Object.fromEntries(
    Object.entries(messageVersionsByParentId).map(([parentId, versions]) => [
      parentId,
      versions.map((version) => messageById.get(version.id) ?? version),
    ]),
  ), [messageById, messageVersionsByParentId]);

  useEffect(() => {
    if (!activeConversationId || !assistantVersionParentIdsKey) {
      setMessageVersionsByParentId((prev) => (Object.keys(prev).length > 0 ? {} : prev));
      return;
    }

    const resourceKey = `${activeConversationId}\n${assistantVersionParentIdsKey}`;
    const cachedVersionIds = messageVersionsCacheRef.current.get(resourceKey);
    if (cachedVersionIds) {
      const currentMessagesById = new Map(
        useConversationStore.getState().messages.map((message) => [message.id, message]),
      );
      const cachedVersions: Record<string, Message[]> = {};
      let cacheComplete = true;
      for (const [parentId, versionIds] of Object.entries(cachedVersionIds)) {
        const versions = versionIds
          .map((messageId) => currentMessagesById.get(messageId))
          .filter((message): message is Message => Boolean(message));
        if (versions.length !== versionIds.length) {
          cacheComplete = false;
          break;
        }
        cachedVersions[parentId] = versions;
      }
      if (!cacheComplete) {
        messageVersionsCacheRef.current.delete(resourceKey);
      } else {
        messageVersionsCacheRef.current.delete(resourceKey);
        messageVersionsCacheRef.current.set(resourceKey, cachedVersionIds);
        setMessageVersionsByParentId(cachedVersions);
        return;
      }
    }

    let cancelled = false;
    let frameId = 0;
    let idleId: number | null = null;
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const parentMessageIds = assistantVersionParentIdsKey
      .split('\n')
      .map((entry) => entry.split('\0', 1)[0])
      .filter(Boolean);
    const startedAt = perfNow();
    const load = () => {
      listMessageVersionsBatch(activeConversationId, parentMessageIds).then((result) => {
        perfTraceDuration('chat.messageVersions.ready', startedAt, {
          conversationId: activeConversationId,
          parentCount: parentMessageIds.length,
        });
        if (cancelled) return;
        messageVersionsCacheRef.current.set(
          resourceKey,
          Object.fromEntries(parentMessageIds.map((parentId) => [
            parentId,
            (result[parentId] ?? []).map((message) => message.id),
          ])),
        );
        while (messageVersionsCacheRef.current.size > 8) {
          const oldestKey = messageVersionsCacheRef.current.keys().next().value;
          if (!oldestKey) break;
          messageVersionsCacheRef.current.delete(oldestKey);
        }
        setMessageVersionsByParentId(result);
        for (const [parentId, versions] of Object.entries(result)) {
          if (versions.length > 0) {
            hydrateMessageVersions(parentId, versions);
          }
        }
      });
    };

    frameId = window.requestAnimationFrame(() => {
      if (typeof win.requestIdleCallback === 'function') {
        idleId = win.requestIdleCallback(load, { timeout: 500 });
      } else {
        load();
      }
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      if (idleId !== null && typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(idleId);
      }
    };
  }, [activeConversationId, assistantVersionParentIdsKey, hydrateMessageVersions, listMessageVersionsBatch]);
  // Separate lookup: parent message id → active assistant message (for stable bubble keys)
  const assistantByParentId = useMemo(() => {
    const map = new Map<string, Message>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.parent_message_id && msg.is_active !== false) {
        map.set(msg.parent_message_id, msg);
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
        // Group by provider + model; fall back to a per-message key so that
        // error messages with incomplete metadata are still counted as
        // distinct responses and don't break multi-model detection.
        modelsByParent.get(msg.parent_message_id)!.add(getMessageVersionGroupKey(msg));
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
  const [displayVersionOverrides, setDisplayVersionOverrides] = useState<Map<string, Map<string, string>>>(new Map());
  const [pendingDisplayVersionSelections, setPendingDisplayVersionSelections] = useState<Map<string, Map<string, PendingDisplayVersionSelection>>>(new Map());
  const retainedChatCacheKeys = useMemo(() => collectRetainedChatCacheKeys(
    messages,
    MAX_LOADED_MESSAGES,
    streamingMessageId ? [streamingMessageId] : [],
  ), [messages, streamingMessageId]);
  const transientCacheConversationIdRef = useRef(activeConversationId);

  useEffect(() => {
    if (transientCacheConversationIdRef.current === activeConversationId) return;
    transientCacheConversationIdRef.current = activeConversationId;
    multiModelVersionsRef.current.clear();
    contentRendererMessageIdsRef.current.clear();
    if (streamingMessageId) contentRendererMessageIdsRef.current.add(streamingMessageId);
    setDisplayModeOverrides((prev) => (prev.size > 0 ? new Map() : prev));
    setDisplayVersionOverrides((prev) => (prev.size > 0 ? new Map() : prev));
    setPendingDisplayVersionSelections((prev) => (prev.size > 0 ? new Map() : prev));
  }, [activeConversationId, streamingMessageId]);

  useEffect(() => {
    multiModelVersionsRef.current = retainMapKeys(
      multiModelVersionsRef.current,
      retainedChatCacheKeys.parentIds,
    );
    contentRendererMessageIdsRef.current = retainSetValues(
      contentRendererMessageIdsRef.current,
      retainedChatCacheKeys.messageIds,
    );
    setDisplayModeOverrides((prev) => retainMapKeys(prev, retainedChatCacheKeys.parentIds));
    setDisplayVersionOverrides((prev) => retainMapKeys(prev, retainedChatCacheKeys.parentIds));
    setPendingDisplayVersionSelections((prev) => retainMapKeys(prev, retainedChatCacheKeys.parentIds));
  }, [retainedChatCacheKeys]);

  const handleDisplayModeOverride = useCallback((parentMsgId: string, mode: MultiModelDisplayMode) => {
    setDisplayModeOverrides((prev) => {
      const next = new Map(prev);
      next.set(parentMsgId, mode);
      return next;
    });
  }, []);
  const handleDisplayVersionOverride = useCallback((parentMsgId: string, modelKey: string, messageId: string) => {
    setDisplayVersionOverrides((prev) => {
      const next = new Map(prev);
      const modelSelections = new Map(next.get(parentMsgId) ?? []);
      modelSelections.set(modelKey, messageId);
      next.set(parentMsgId, modelSelections);
      return next;
    });
  }, []);
  const handleGeneratedVersionCreated = useCallback((version: Message) => {
    if (!version.parent_message_id) return;
    const modelKey = getMessageVersionGroupKey(version);
    setPendingDisplayVersionSelections((prev) => {
      const next = new Map(prev);
      const modelSelections = new Map(next.get(version.parent_message_id!) ?? []);
      modelSelections.set(modelKey, {
        messageId: version.id,
        versionIndex: version.version_index,
        createdAt: version.created_at,
      });
      next.set(version.parent_message_id!, modelSelections);
      return next;
    });
    handleDisplayVersionOverride(
      version.parent_message_id,
      modelKey,
      version.id,
    );
  }, [handleDisplayVersionOverride]);

  useEffect(() => {
    if (pendingDisplayVersionSelections.size === 0) return;

    setDisplayVersionOverrides((prev) => {
      let changed = false;
      const next = new Map(prev);

      for (const [parentMsgId, pendingByModel] of pendingDisplayVersionSelections) {
        const modelSelections = new Map(next.get(parentMsgId) ?? []);
        const parentVersions = messages.filter((message) =>
          message.parent_message_id === parentMsgId && message.role === 'assistant'
        );

        for (const [modelKey, pending] of pendingByModel) {
          const selectedId = modelSelections.get(modelKey);
          const resolvedId = resolvePendingDisplayVersionSelection(
            parentVersions,
            modelKey,
            selectedId,
            pending,
          );
          if (resolvedId && resolvedId !== selectedId) {
            modelSelections.set(modelKey, resolvedId);
            changed = true;
          }
        }

        if (changed) {
          next.set(parentMsgId, modelSelections);
        }
      }

      return changed ? next : prev;
    });

    setPendingDisplayVersionSelections((prev) => {
      let changed = false;
      const next = new Map(prev);

      for (const [parentMsgId, pendingByModel] of prev) {
        const modelSelections = new Map(pendingByModel);
        const parentVersions = messages.filter((message) =>
          message.parent_message_id === parentMsgId && message.role === 'assistant'
        );
        const displaySelections = displayVersionOverrides.get(parentMsgId);

        for (const [modelKey, pending] of pendingByModel) {
          const selectedId = displaySelections?.get(modelKey);
          const resolvedId = resolvePendingDisplayVersionSelection(
            parentVersions,
            modelKey,
            selectedId,
            pending,
          );
          if (
            resolvedId
            && resolvedId !== pending.messageId
            && parentVersions.some((version) => version.id === resolvedId)
          ) {
            modelSelections.delete(modelKey);
            changed = true;
          }
        }

        if (modelSelections.size > 0) {
          next.set(parentMsgId, modelSelections);
        } else {
          next.delete(parentMsgId);
        }
      }

      return changed ? next : prev;
    });
  }, [displayVersionOverrides, messages, pendingDisplayVersionSelections]);

  const handleRegenerateDisplayedVersion = useCallback(async (version: Message) => {
    try {
      let pending: Promise<Message>;
      if (version.provider_id && version.model_id) {
        pending = regenerateWithModel(version.id, version.provider_id, version.model_id, { activate: version.is_active });
      } else {
        pending = regenerateMessage(version.id);
      }
      const localGenerated = findLatestLocalGeneratedVersion(version.parent_message_id, version.provider_id, version.model_id);
      if (localGenerated) handleGeneratedVersionCreated(localGenerated);
      const generated = await pending;
      handleGeneratedVersionCreated(
        findLatestLocalGeneratedVersion(version.parent_message_id, version.provider_id, version.model_id) ?? generated,
      );
    } catch (e) {
      messageApi.error(String(e));
    }
  }, [handleGeneratedVersionCreated, messageApi, regenerateMessage, regenerateWithModel]);

  const handleSwitchDisplayedVersionModel = useCallback(async (version: Message, providerId: string, modelId: string) => {
    try {
      const pending = regenerateWithModel(version.id, providerId, modelId, { activate: version.is_active });
      const localGenerated = findLatestLocalGeneratedVersion(version.parent_message_id, providerId, modelId);
      if (localGenerated) handleGeneratedVersionCreated(localGenerated);
      const generated = await pending;
      handleGeneratedVersionCreated(
        findLatestLocalGeneratedVersion(version.parent_message_id, providerId, modelId) ?? generated,
      );
    } catch (e) {
      messageApi.error(String(e));
    }
  }, [handleGeneratedVersionCreated, messageApi, regenerateWithModel]);

  const handleSetContextVersion = useCallback(async (version: Message) => {
    if (!activeConversationId || !version.parent_message_id) return;
    try {
      await switchMessageVersion(activeConversationId, version.parent_message_id, version.id);
    } catch (e) {
      messageApi.error(String(e));
    }
  }, [activeConversationId, messageApi, switchMessageVersion]);

  const handleBranchDisplayedVersion = useCallback((version: Message, asChild: boolean) => {
    const currentTitle = conversations.find((c) => c.id === activeConversationId)?.title ?? '';
    setCardBranchTarget({ messageId: version.id, asChild });
    setCardBranchTitle(currentTitle);
  }, [activeConversationId, conversations]);

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
        const signature = `user:${createChatContentFingerprint(userContent)}`;
        const cached = cache.get(msg.id);
        const item = cached?.signature === signature
          ? cached.item
          : { key: msg.id, role: 'user', content: userContent };
        nextCache.set(msg.id, { signature, item });
        nextItems.push(item);
        continue;
      }

      let aiContent = msg.role === 'assistant'
        ? buildAssistantDisplayContent(msg, messageById)
        : msg.content;
      if (shouldHideAssistantBubble(msg, aiContent)) continue;
      if (msg.role === 'assistant') {
        const isStreamingForRender = isAssistantStreamingForRender({
          isStreaming: streaming,
          messageId: msg.id,
          streamingMessageId,
          status: msg.status,
        });
        aiContent = closeStreamingThinkBlock(
          aiContent,
          thinkingActiveMessageIds.has(msg.id) || isStreamingForRender,
        );
      }
      // Use parent_message_id as stable key for assistant bubbles to avoid
      // unmount/remount flash when switching versions. Prefix with "ai:" to
      // prevent key collision with the user message (which shares the same id).
      // Skip duplicate assistant messages with the same parent (multi-model parallel race).
      const stableKey = msg.parent_message_id ? `ai:${msg.parent_message_id}` : msg.id;
      if (nextCache.has(stableKey)) continue; // already rendered for this parent
      const displaySignature = msg.role === 'assistant' ? searchDisplayByMessageId[msg.id] ?? '' : '';
      const signature = [
        'ai',
        msg.id,
        msg.status,
        createChatContentFingerprint(displaySignature),
        createChatContentFingerprint(aiContent),
      ].join(':');
      const cached = cache.get(stableKey);
      const item = cached?.signature === signature
        ? cached.item
        : { key: stableKey, role: 'ai', content: aiContent };
      nextCache.set(stableKey, { signature, item });
      nextItems.push(item);
    }

    bubbleItemCacheRef.current = nextCache;
    return nextItems;
  }, [activeMessages, messageById, searchDisplayByMessageId, streaming, streamingMessageId, thinkingActiveMessageIds, userSearchContentById]);

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
  const lastAutoScrollRequestRef = useRef<{
    items: typeof finalBubbleItems;
    stickToBottom: boolean;
  } | null>(null);

  useEffect(() => {
    const previousRequest = lastAutoScrollRequestRef.current;
    if (
      previousRequest?.items === finalBubbleItems
      && previousRequest.stickToBottom === stickToBottom
    ) {
      return;
    }
    lastAutoScrollRequestRef.current = { items: finalBubbleItems, stickToBottom };

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
  const aiContentNodesById = useMemo(() => {
    const next = new Map<string, ChatMarkdownNode[]>();

    for (const item of bubbleItems) {
      if (item.role !== 'ai' || typeof item.content !== 'string') {
        continue;
      }
      // Skip error messages — they render as Alert, not markdown
      const msg = resolveAssistantMessageForBubbleKey(item.key, assistantByParentId, messageById);
      if (msg?.status === 'error') {
        continue;
      }
      // Skip the actively streaming message — NodeRenderer handles incremental
      // parsing via its `content` prop. Keep that same renderer path after
      // completion so the message does not switch from `content` to
      // `nodes` and visibly re-render a second time.
      const shouldRenderFromContent = shouldRenderAssistantMarkdownFromContent(
        isAssistantStreamingForRender({
          isStreaming: streaming,
          messageId: msg?.id,
          streamingMessageId,
          status: msg?.status,
        }),
        Boolean(msg?.id && contentRendererMessageIdsRef.current.has(msg.id)),
      );
      if (shouldRenderFromContent) {
        continue;
      }

      const messageId = String(item.key);
      if (shouldDeferAssistantMarkdownParse(item.content)) {
        continue;
      }

      const renderableContent = normalizeStoredMediaUrlsForPlatform(item.content);
      const cached = getCachedChatMarkdown(messageId, renderableContent);
      if (cached) {
        next.set(messageId, cached);
        continue;
      }

      const nodes = safeParseChatMarkdown(renderableContent);
      setCachedChatMarkdown(messageId, renderableContent, nodes);
      next.set(messageId, nodes);
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
    const renderUserContent = (content: string, textAlign?: React.CSSProperties['textAlign']) => {
      if (!content) return null;
      const renderAsMarkdown = settings.render_user_markdown && !shouldUsePlainTextChatContent(content, {
        role: 'user',
        isStreaming: false,
      });
      if (!renderAsMarkdown) {
        return <PlainTextChatContent content={content} textAlign={textAlign} />;
      }
      return (
        <ChatMessageRenderBoundary
          fallback={(
            <MessageRenderFallback
              content={content}
              notice={t('chat.messageRenderFallback')}
              textAlign={textAlign}
            />
          )}
        >
          <AssistantMarkdown
            content={content}
            cacheKey={msg?.id ?? `user:${createChatContentFingerprint(content)}`}
            isDarkMode={isDarkMode}
            isStreaming={false}
            codeBlockDarkTheme={codeBlockDarkTheme}
            codeBlockLightTheme={codeBlockLightTheme}
            codeBlockThemes={codeBlockThemes}
            codeFontFamily={settings.code_font_family || undefined}
          />
        </ChatMessageRenderBoundary>
      );
    };
    return {
      placement: 'end' as const,
      ...getBubbleVariant(true),
      avatar: userAvatar,
      styles: getShareSelectBubbleStyles(msg?.id),
      contentRender: attachments.length > 0
        ? (content: string) => wrapShareSelectableContent(msg?.id, (
            <div style={{ textAlign: 'right' }}>
              <span data-aqbot-msg={msg?.id} style={{ height: 0, overflow: 'hidden', lineHeight: 0 }} />
              {renderUserContent(content, 'right')}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: content ? 8 : 0, justifyContent: 'flex-end' }}>
                {attachments.map((att, i) => (
                  <MessageAttachmentPreview
                    key={att.id || `${att.file_name}-${i}`}
                    attachment={att}
                    themeColor={token.colorPrimary}
                  />
                ))}
              </div>
            </div>
          ))
        : (content: string) => wrapShareSelectableContent(msg?.id, (
            <>
              <span data-aqbot-msg={msg?.id} style={{ height: 0, overflow: 'hidden', lineHeight: 0 }} />
              {renderUserContent(content)}
            </>
          )),
      header: (
        <div onClick={(e) => handleShareSelectableClick(msg?.id, e)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: shareSelectMode ? 'pointer' : undefined }}>
            {shareSelectMode && msg && (
              <Checkbox
                checked={selectedShareMessageIds.includes(msg.id)}
                onChange={() => toggleShareMessage(msg.id)}
                onClick={(e) => e.stopPropagation()}
              />
            )}
            <Typography.Text style={{ fontSize: 13 }}>{profile.name || t('chat.you')}</Typography.Text>
            {msg && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {formatTime(msg.created_at)}
              </Typography.Text>
            )}
          </div>
        </div>
      ),
      footer: shareSelectMode ? null : (
        <Actions
          items={[
            {
              key: 'copy',
              icon: (() => { const ct = stripUserAqbotTags(String(bubbleData.content ?? '')); return isUserMsgCopied(ct) ? <Check size={14} style={{ color: token.colorSuccess }} /> : <Copy size={14} />; })(),
              label: t('chat.copy'),
              onItemClick: () => {
                void copyMessage(stripUserAqbotTags(String(bubbleData.content ?? ''))).then(ok => {
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
  }, [activeConversationId, codeBlockDarkTheme, codeBlockLightTheme, codeBlockThemes, deleteMessageGroup, formatTime, getBubbleVariant, getShareSelectBubbleStyles, handleEditMessage, handleShareSelectableClick, isDarkMode, messageApi, messageById, profile.name, regenerateMessage, selectedShareMessageIds, settings.code_font_family, settings.render_user_markdown, shareSelectMode, t, toggleShareMessage, token.colorError, token.colorPrimary, userAvatar, wrapShareSelectableContent]);

  const renderStreamingStatusIndicator = useCallback((
    activity: StreamActivity | undefined,
    hasModelText: boolean,
    style?: React.CSSProperties,
  ) => {
    const presentation = getStreamingStatusPresentation({
      isStreaming: streaming,
      activity,
      now: streamStatusNow,
      hasModelText,
    });
    if (!presentation) {
      return null;
    }

    const color = presentation.tone === 'warning' ? token.colorWarning : token.colorPrimary;
    return (
      <span
        className="aqbot-streaming-status"
        aria-label={t(presentation.labelKey)}
        style={{ color, ...style }}
      >
        <span className="aqbot-streaming-dots" aria-hidden="true">
          <span /><span /><span />
        </span>
        <Typography.Text style={{ fontSize: 12, color }}>
          {t(presentation.labelKey)}
        </Typography.Text>
      </span>
    );
  }, [streaming, streamStatusNow, t, token.colorPrimary, token.colorWarning]);

  const aiRole = useCallback((bubbleData: BubbleItemType) => {
    // bubbleData.key is parent_message_id for stable rendering
    const msg = resolveAssistantMessageForBubbleKey(bubbleData.key, assistantByParentId, messageById);
    const msgActivity = msg?.id ? streamActivityByMessageId[msg.id] : undefined;
    const isStreaming = isAssistantStreamingForRender({
      isStreaming: streaming,
      messageId: msg?.id,
      streamingMessageId,
      status: msg?.status,
    });
    const shouldRenderFromContent = shouldRenderAssistantMarkdownFromContent(
      isStreaming,
      Boolean(msg?.id && contentRendererMessageIdsRef.current.has(msg.id)),
    );
    const assistantCopyText = stripAssistantAqbotTags(msg?.content ?? (typeof bubbleData.content === 'string' ? bubbleData.content : ''));
    const searchDisplayPrefix = msg?.id ? searchDisplayByMessageId[msg.id] : undefined;
    const ragDisplayPrefix = msg?.id ? ragDisplayByMessageId[msg.id] : undefined;
    const displayPrefix = `${searchDisplayPrefix ?? ''}${ragDisplayPrefix ?? ''}` || undefined;
    const parsedNodes = shouldRenderFromContent || displayPrefix
      ? undefined
      : aiContentNodesById.get(String(bubbleData.key));
    const { footerLoading: rawFooterLoading } = getStreamingLoadingState(isStreaming, bubbleData.content);
    const hasModelText = hasModelVisibleContent(bubbleData.content, stripAssistantAqbotTags);
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
      const versionIsStreaming = isVersionStreaming || isAssistantStreamingForRender({
        isStreaming: streaming,
        messageId: versionMessage.id,
        streamingMessageId,
        status: versionMessage.status,
      });
      const buildVersionContent = (content: string) => closeStreamingThinkBlock(
        buildAssistantDisplayContent({ ...versionMessage, content }, messageById),
        versionIsStreaming,
      );
      const renderVersionNode = (versionContent: string) => {
        if (versionMessage.status === 'error') {
          return <Alert type="error" message={versionContent} showIcon />;
        }
        if (shouldShowInitialStreamingDots(versionIsStreaming, versionContent, stripAssistantAqbotTags)) {
          return (
            renderStreamingStatusIndicator(streamActivityByMessageId[versionMessage.id], false)
          );
        }
        return (
          <ChatMessageRenderBoundary
            fallback={(
              <MessageRenderFallback
                content={versionContent}
                notice={t('chat.messageRenderFallback')}
              />
            )}
          >
            <AssistantMarkdown
              content={versionContent}
              cacheKey={versionMessage.id}
              isDarkMode={isDarkMode}
              isStreaming={versionIsStreaming}
              codeBlockDarkTheme={codeBlockDarkTheme}
              codeBlockLightTheme={codeBlockLightTheme}
              codeBlockThemes={codeBlockThemes}
              codeFontFamily={settings.code_font_family || undefined}
            />
          </ChatMessageRenderBoundary>
        );
      };

      if (versionIsStreaming) {
        return (
          <StreamingAssistantContent
            messageId={versionMessage.id}
            baseContent={versionMessage.content}
            isStreaming={versionIsStreaming}
          >
            {(liveContent) => renderVersionNode(buildVersionContent(liveContent))}
          </StreamingAssistantContent>
        );
      }

      return renderVersionNode(buildVersionContent(versionMessage.content));
    };

    return {
      placement: 'start' as const,
      ...getBubbleVariant(false),
      avatar: isNonTabsMultiModel ? undefined : renderConvIconForChat(32, msg?.model_id),
      loading: bubbleLoading,
      styles: getShareSelectBubbleStyles(msg?.id),
      contentRender: (content: string) => {
        const baseRenderContent = typeof content === 'string' && content.length > 0
          ? content
          : (msg?.content ?? '');
        const renderContentNode = (renderContent: string) => {
          const renderContentHasSearchDisplay = /<(?:web-search-query|web-search)\b[^>]*data-aqbot=["']1["'][^>]*>/i.test(renderContent);
          const effectiveDisplayPrefix = `${renderContentHasSearchDisplay ? '' : searchDisplayPrefix ?? ''}${ragDisplayPrefix ?? ''}` || undefined;
          const renderLoadingState = getStreamingLoadingState(isStreaming, renderContent);
          const hasDisplayContent = hasAqbotDisplayContent(renderContent) || Boolean(effectiveDisplayPrefix);
          const hasRenderedModelText = hasModelVisibleContent(renderContent, stripAssistantAqbotTags);
          const shouldShowInitialDots = renderLoadingState.bubbleLoading && !hasDisplayContent;
          const hasActiveThinkingOnly = Boolean(msg?.id && thinkingActiveMessageIds.has(msg.id) && !hasRenderedModelText);
          const shouldShowInlineStatus = shouldShowInlineStreamingStatus({
            isStreaming,
            hasDisplayContent,
            hasActiveThinkingOnly,
            hasRenderedModelText,
          });
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
                  onRegenerateVersion={handleRegenerateDisplayedVersion}
                  onEditVersion={(version) => handleEditMessage(version.id, version.content, 'assistant')}
                  onBranchVersion={handleBranchDisplayedVersion}
                  onSwitchModelVersion={handleSwitchDisplayedVersionModel}
                  onSetContextVersion={handleSetContextVersion}
                  onDisplayVersionChange={handleDisplayVersionOverride}
                  displayVersionIdsByModelKey={displayVersionOverrides.get(parentId)}
                  streamingMessageId={streamingMessageId}
                  multiModelDoneMessageIds={multiModelDoneMessageIds}
                  getModelDisplayInfo={getModelDisplayInfo}
                  renderContent={renderVersionContent}
                />
              </>
            );
          }

          if (shouldRenderStandaloneAssistantError(msg?.status, isNonTabsMultiModel)) {
            const errorDisplay = splitAssistantErrorDisplayContent(renderContent);
            return (
              <>
                {msgMarker}
                {errorDisplay.prefix && (
                  <ChatMessageRenderBoundary
                    fallback={(
                      <MessageRenderFallback
                        content={errorDisplay.prefix}
                        notice={t('chat.messageRenderFallback')}
                      />
                    )}
                  >
                    <AssistantMarkdown
                      content={errorDisplay.prefix}
                      cacheKey={`${msg?.id ?? String(bubbleData.key)}:error-prefix`}
                      isDarkMode={isDarkMode}
                      isStreaming={false}
                      codeBlockDarkTheme={codeBlockDarkTheme}
                      codeBlockLightTheme={codeBlockLightTheme}
                      codeBlockThemes={codeBlockThemes}
                      codeFontFamily={settings.code_font_family || undefined}
                    />
                  </ChatMessageRenderBoundary>
                )}
                <Alert type="error" message={errorDisplay.message} showIcon />
              </>
            );
          }

          if (!isAgentMsg && shouldShowInitialDots) {
            return (
              <>{msgMarker}{renderStreamingStatusIndicator(msgActivity, false)}</>
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
              <>{msgMarker}{renderStreamingStatusIndicator(msgActivity, false)}</>
            );
          }

          return (
            <>
              {msgMarker}
              <ChatMessageRenderBoundary
                fallback={(
                  <MessageRenderFallback
                    content={renderContent}
                    notice={t('chat.messageRenderFallback')}
                  />
                )}
              >
                <AssistantMarkdown
                  content={renderContent}
                  nodes={parsedNodes}
                  cacheKey={msg?.id ?? String(bubbleData.key)}
                  isDarkMode={isDarkMode}
                  isStreaming={isStreaming}
                  codeBlockDarkTheme={codeBlockDarkTheme}
                  codeBlockLightTheme={codeBlockLightTheme}
                  codeBlockThemes={codeBlockThemes}
                  codeFontFamily={settings.code_font_family || undefined}
                  displayPrefix={effectiveDisplayPrefix}
                />
              </ChatMessageRenderBoundary>
              {!isAgentMsg && shouldShowInlineStatus && (
                <div style={{ marginTop: 8 }}>
                  {renderStreamingStatusIndicator(msgActivity, false)}
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
                <div style={{ marginTop: 8 }}>
                  {renderStreamingStatusIndicator(msgActivity, hasModelText)}
                </div>
              )}
            </>
          );
        };

        if (isStreaming && msg?.id) {
          return wrapShareSelectableContent(msg.id, (
            <StreamingAssistantContent
              messageId={msg.id}
              baseContent={baseRenderContent}
              isStreaming={isStreaming}
            >
              {(liveContent) => renderContentNode(closeStreamingThinkBlock(
                liveContent,
                thinkingActiveMessageIds.has(msg.id) || isStreaming,
              ))}
            </StreamingAssistantContent>
          ));
        }

        return wrapShareSelectableContent(msg?.id, renderContentNode(baseRenderContent));
      },
      header: (() => {
        if (isNonTabsMultiModel && !shareSelectMode) return null;
        const { modelName, providerName } = getModelDisplayInfo(msg?.model_id, msg?.provider_id);
        return (
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 2, cursor: shareSelectMode ? 'pointer' : undefined }}
            onClick={(e) => handleShareSelectableClick(msg?.id, e)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {shareSelectMode && msg && (
                <Checkbox
                  checked={selectedShareMessageIds.includes(msg.id)}
                  onChange={() => toggleShareMessage(msg.id)}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
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
      footer: shareSelectMode ? null : msg && activeConversationId ? (
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
              {renderStreamingStatusIndicator(msgActivity, true)}
            </div>
          )}
          {!isStreaming && (
            <AssistantFooter
              msg={msg}
              conversationId={activeConversationId}
              versions={msg.parent_message_id ? currentMessageVersionsByParentId[msg.parent_message_id] : undefined}
              assistantCopyText={assistantCopyText}
              getModelDisplayInfo={getModelDisplayInfo}
              onEditMessage={handleEditMessage}
              displayMode={effectiveDisplayMode}
              onDisplayModeChange={handleDisplayModeOverride}
              onMultiModelDetected={handleMultiModelDetected}
              onRegeneratedVersionCreated={handleGeneratedVersionCreated}
            />
          )}
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
          {renderStreamingStatusIndicator(msgActivity, true)}
        </div>
      ) : null,
    };
  }, [activeConversation, activeConversationId, activeMessages, agentPendingPermissions, agentToolCalls, aiContentNodesById, assistantByParentId, codeBlockDarkTheme, codeBlockLightTheme, codeBlockThemes, currentMessageVersionsByParentId, deleteMessage, displayModeOverrides, displayVersionOverrides, formatTime, getBubbleVariant, getModelDisplayInfo, getShareSelectBubbleStyles, handleBranchDisplayedVersion, handleDisplayModeOverride, handleDisplayVersionOverride, handleEditMessage, handleGeneratedVersionCreated, handleMultiModelDetected, handleRegenerateDisplayedVersion, handleSetContextVersion, handleShareSelectableClick, handleSwitchDisplayedVersionModel, isDarkMode, messageById, messages, multiModelDoneMessageIds, multiModelParentId, multiModelResponseParents, ragDisplayByMessageId, renderConvIconForChat, renderStreamingStatusIndicator, searchDisplayByMessageId, selectedShareMessageIds, settings, shareSelectMode, streamActivityByMessageId, streaming, streamingMessageId, switchMessageVersion, t, toggleShareMessage, token.colorPrimary, token.colorTextDescription, wrapShareSelectableContent]);

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
              onClick={() => {
                void openCompressionSummaryModal();
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
  }, [activeConversationId, deleteCompression, openCompressionSummaryModal, t, token.colorPrimary, token.colorPrimaryBorder, token.colorTextTertiary]);

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
        .bubble-user-background .ant-bubble-end .ant-bubble-content {
          background: var(--chat-user-message-area-color, transparent) !important;
          border: none !important;
          border-radius: 8px;
          box-sizing: border-box;
          margin-block: 6px;
          padding: 8px 12px;
        }
        .bubble-user-border .ant-bubble-end .ant-bubble-content {
          border: var(--chat-user-message-area-border-width, 1px) solid var(--chat-user-message-area-color, var(--border-color)) !important;
          border-radius: 8px;
          box-sizing: border-box;
          margin-block: 6px;
          padding: 8px 12px;
        }
        .bubble-ai-background .ant-bubble-start .ant-bubble-content {
          background: var(--chat-ai-message-area-color, transparent) !important;
          border: none !important;
          border-radius: 8px;
          box-sizing: border-box;
          margin-block: 6px;
          padding: 8px 12px;
        }
        .bubble-ai-border .ant-bubble-start .ant-bubble-content {
          border: var(--chat-ai-message-area-border-width, 1px) solid var(--chat-ai-message-area-color, var(--border-color)) !important;
          border-radius: 8px;
          box-sizing: border-box;
          margin-block: 6px;
          padding: 8px 12px;
        }
        .bubble-ai-background .context-clear-bubble .ant-bubble-content,
        .bubble-ai-border .context-clear-bubble .ant-bubble-content {
          background: transparent !important;
          border: none !important;
          margin-block: 0;
          padding: 4px 0;
        }
        .aqbot-streaming-dots {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-height: 16px;
        }
        .aqbot-streaming-status {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 18px;
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
        .aqbot-chat-title-shell {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          min-width: 0;
          max-width: min(42vw, 420px);
          flex: 0 1 auto;
          cursor: pointer;
        }
        .aqbot-chat-title-text {
          min-width: 0;
          max-width: 100%;
        }
      `}</style>

      {/* Top Bar */}
      <div className="flex items-center gap-2 px-3 py-3">
        {activeConversation ? (
          <>
            {renderChatSidebarToggle()}
            {renderConvIconForChat(24)}
            {editingTitle ? (
              <div className="aqbot-chat-title-shell" style={{ cursor: 'default' }}>
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
              <span
                className="aqbot-chat-title-shell select-none"
                onClick={handleTitleClick}
              >
                <Typography.Text
                  className="aqbot-chat-title-text"
                  ellipsis={{ tooltip: activeConversation.title }}
                >
                  {activeConversation.title}
                </Typography.Text>
                {isTitleGenerating
                  ? <SyncOutlined spin className="text-xs opacity-50" style={{ flexShrink: 0 }} />
                  : <Pencil size={12} className="text-xs opacity-50" style={{ flexShrink: 0 }} />
                }
              </span>
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
            {renderChatSidebarToggle()}
            <Typography.Text type="secondary">{t('chat.welcome')}</Typography.Text>
            <div className="flex-1" />
            <ModelSelector />
          </>
        )}
      </div>

      {/* Message Area */}
      <div
        ref={messageAreaRef}
        data-message-area
        className={`flex-1 min-h-0 overflow-hidden relative bubble-${bubbleStyle || 'modern'}${userMessageAreaClass}${aiMessageAreaClass}`}
        style={messageAreaStyle}
      >
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
            roleIntro ? (
              <div
                className="flex flex-col items-center justify-center h-full"
                style={{ padding: '0 24px', textAlign: 'center', gap: 16 }}
              >
                {roleIntro.openingMessage ? (
                  <Typography.Text
                    type="secondary"
                    style={{ maxWidth: 620, fontSize: 15, lineHeight: 1.7 }}
                  >
                    {roleIntro.openingMessage}
                  </Typography.Text>
                ) : null}
                {roleIntroPromptItems.length > 0 ? (
                  <Prompts
                    items={roleIntroPromptItems}
                    onItemClick={handleRoleIntroPromptClick}
                    wrap
                    style={{ marginTop: 4, justifyContent: 'center' }}
                  />
                ) : null}
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
                visibility: showingPreviousConversationWindow ? 'hidden' : undefined,
                padding: settings.chat_minimap_enabled && settings.chat_minimap_style === 'sticky'
                  ? '50px 24px 16px 24px'
                  : '16px 24px',
                overflowX: 'hidden',
              }}
            />
            {shareSelectMode && (
              <div
                data-export-hide="true"
                style={{
                  position: 'absolute',
                  left: '50%',
                  bottom: 16,
                  transform: 'translateX(-50%)',
                  zIndex: 20,
                  display: 'flex',
                  flexDirection: 'row',
                  flexWrap: 'nowrap',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 14px',
                  borderRadius: 12,
                  background: token.colorBgElevated,
                  boxShadow: token.boxShadowSecondary,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  maxWidth: 'min(720px, calc(100% - 32px))',
                  whiteSpace: 'nowrap',
                }}
              >
                <Typography.Text style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {t('chat.shareSelectedCount', { count: selectedShareMessageIds.length })}
                </Typography.Text>
                <Button size="small" onClick={selectAllShareMessages}>
                  {t('chat.shareSelectAll')}
                </Button>
                <Button
                  size="small"
                  type="primary"
                  icon={<FileImage size={14} />}
                  loading={shareExporting}
                  disabled={selectedShareMessageIds.length === 0}
                  onClick={() => { void exportSelectedShare('png'); }}
                >
                  {t('chat.exportPng')}
                </Button>
                <Dropdown
                  menu={{
                    items: [
                      {
                        key: 'md',
                        icon: <FileCode size={14} />,
                        label: t('chat.exportMd'),
                        disabled: selectedShareMessageIds.length === 0 || shareExporting,
                        onClick: () => { void exportSelectedShare('md'); },
                      },
                      {
                        key: 'copy-md',
                        icon: <Copy size={14} />,
                        label: t('chat.copyMarkdown'),
                        disabled: selectedShareMessageIds.length === 0 || shareExporting,
                        onClick: () => { void exportSelectedShare('copy-md'); },
                      },
                    ],
                  }}
                  placement="top"
                  trigger={['click']}
                  disabled={selectedShareMessageIds.length === 0 || shareExporting}
                >
                  <Button
                    size="small"
                    disabled={selectedShareMessageIds.length === 0 || shareExporting}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {t('chat.shareMoreFormats')}
                      <ChevronDown size={12} />
                    </span>
                  </Button>
                </Dropdown>
                <Button size="small" icon={<X size={14} />} onClick={exitShareSelectMode}>
                  {t('common.cancel')}
                </Button>
              </div>
            )}
            <ChatScrollIndicator onUserScrollIntent={markUserScrollIntent} />
            <MinimapScrollProvider scrollTo={minimapScrollTo} scrollBoxRef={scrollBoxRef}>
              <ChatMinimap />
            </MinimapScrollProvider>
            {showingPreviousConversationWindow && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center"
                style={{
                  gap: 12,
                  padding: '0 24px',
                  color: token.colorTextSecondary,
                  background: token.colorBgContainer,
                  zIndex: 1,
                }}
              >
                <SyncOutlined spin style={{ fontSize: 20, color: token.colorPrimary }} />
                <Typography.Text type="secondary">
                  {t('chat.loadingConversation')}
                </Typography.Text>
              </div>
            )}
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
        onCancel={() => {
          setSummaryModalOpen(false);
          setSummaryModalSummary(null);
          setSummaryModalTab('summary');
        }}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button
              icon={<RotateCcw size={14} />}
              loading={summaryRetrying || compressing}
              disabled={!summaryModalSummary?.source_text}
              onClick={async () => {
                if (!summaryModalSummary?.source_text) {
                  messageApi.warning(t('chat.retryCompressionNoSource'));
                  return;
                }
                setSummaryRetrying(true);
                try {
                  const next = await retryCompression();
                  if (next) {
                    setSummaryModalSummary(next);
                    setSummaryModalText(next.summary_text);
                    setSummaryModalTab('summary');
                    messageApi.success(t('chat.retryCompressionSuccess'));
                  }
                } catch {
                  messageApi.error(t('chat.retryCompressionFailed'));
                } finally {
                  setSummaryRetrying(false);
                }
              }}
            >
              {t('chat.retryCompression')}
            </Button>
            <Button
              onClick={() => {
                setSummaryModalOpen(false);
                setSummaryModalSummary(null);
                setSummaryModalTab('summary');
              }}
            >
              {t('common.close')}
            </Button>
          </div>
        }
        width={640}
      >
        <div style={{ maxHeight: 480, overflow: 'auto', padding: '8px 0' }}>
          {summaryModalSummary && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {summaryModalSummary.model_used && (
                <Tag>{t('chat.summaryModel')}: {summaryModalSummary.model_used}</Tag>
              )}
              {summaryModalSummary.token_count != null && (
                <Tag>{t('chat.summaryTokens')}: {summaryModalSummary.token_count.toLocaleString()}</Tag>
              )}
              {summaryBoundaryLabel && (
                <Tag>{t('chat.summaryBoundary')}: {summaryBoundaryLabel}</Tag>
              )}
            </div>
          )}
          <Tabs
            activeKey={summaryModalTab}
            onChange={(key) => setSummaryModalTab(key as 'summary' | 'source')}
            items={[
              {
                key: 'summary',
                label: t('chat.compressionSummary'),
                children: (
                  <NodeRenderer
                    content={summaryModalText || t('chat.noSummary')}
                    isDark={isDarkMode}
                    customId="summary"
                    final
                    themes={codeBlockThemes}
                    codeBlockLightTheme={codeBlockLightTheme}
                    codeBlockDarkTheme={codeBlockDarkTheme}
                  />
                ),
              },
              {
                key: 'source',
                label: t('chat.compressionSource'),
                children: summaryModalSummary?.source_text ? (
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: token.colorText,
                    }}
                  >
                    {summaryModalSummary.source_text}
                  </pre>
                ) : (
                  <div style={{ color: token.colorTextSecondary, fontSize: 13 }}>
                    {t('chat.noSourceText')}
                  </div>
                ),
              },
            ]}
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
      <Modal
        title={t('chat.branchConversation')}
        open={!!cardBranchTarget}
        onCancel={() => {
          setCardBranchTarget(null);
          setCardBranchTitle('');
        }}
        onOk={async () => {
          if (!activeConversationId || !cardBranchTarget) return;
          setCardBranchSaving(true);
          try {
            const title = cardBranchTitle.trim() || activeConversation?.title || '';
            await branchConversation(activeConversationId, cardBranchTarget.messageId, cardBranchTarget.asChild, title);
            messageApi.success(t('chat.branchCreated'));
            setCardBranchTarget(null);
            setCardBranchTitle('');
          } catch (e) {
            messageApi.error(String(e));
          } finally {
            setCardBranchSaving(false);
          }
        }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        confirmLoading={cardBranchSaving}
        width={400}
        destroyOnClose
      >
        <Input
          value={cardBranchTitle}
          onChange={(e) => setCardBranchTitle(e.target.value)}
          placeholder={t('chat.branchTitlePlaceholder')}
          autoFocus
          onPressEnter={async () => {
            if (!activeConversationId || !cardBranchTarget) return;
            setCardBranchSaving(true);
            try {
              const title = cardBranchTitle.trim() || activeConversation?.title || '';
              await branchConversation(activeConversationId, cardBranchTarget.messageId, cardBranchTarget.asChild, title);
              messageApi.success(t('chat.branchCreated'));
              setCardBranchTarget(null);
              setCardBranchTitle('');
            } catch (e) {
              messageApi.error(String(e));
            } finally {
              setCardBranchSaving(false);
            }
          }}
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
