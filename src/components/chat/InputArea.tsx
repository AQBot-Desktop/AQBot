import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Button, Tooltip, App, theme, Dropdown, Tag, Popover, Checkbox, Badge } from 'antd';
import type { MenuProps } from 'antd';
import { Paperclip, Trash2, Mic, Eraser, Scissors, Globe, Brain, Atom, Plug, SlidersHorizontal, ArrowUp, Square, Check, Zap, ZapOff, Shrink, Upload, GitCompareArrows, X, BookOpen, GripHorizontal, CircleOff, SignalLow, SignalMedium, SignalHigh, Signal, Bot, MessageSquare, Shield, ShieldCheck, ShieldAlert, FolderOpen, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConversationStore, useProviderStore, useSettingsStore, useSearchStore, useMcpStore, useMemoryStore, useKnowledgeStore } from '@/stores';
import { useUIStore } from '@/stores/uiStore';
import { findModelByIds, supportsReasoning, modelHasCapability } from '@/lib/modelCapabilities';
import { estimateMessageTokens, estimateTokens } from '@/lib/tokenEstimator';
import { McpServerIcon } from '@/components/shared/McpServerIcon';
import { NamespaceIcon } from '@/components/shared/NamespaceIcon';
import { KnowledgeBaseIcon } from '@/components/shared/KnowledgeBaseIcon';
import { getShortcutBinding, formatShortcutForDisplay } from '@/lib/shortcuts';
import type { ShortcutAction } from '@/lib/shortcuts';
import { VoiceCall } from './VoiceCall';
import { ConversationSettingsModal } from './ConversationSettingsModal';
import { ModelSelector } from './ModelSelector';
import { SearchProviderTypeIcon, PROVIDER_TYPE_LABELS } from '@/components/shared/SearchProviderIcon';
import { ModelIcon } from '@lobehub/icons';
import type { AttachmentInput, RealtimeConfig } from '@/types';
import { invoke } from '@/lib/invoke';
import { open } from '@tauri-apps/plugin-dialog';

async function fileToAttachmentInput(file: File): Promise<AttachmentInput> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1] || '';
      resolve({
        file_name: file.name,
        file_type: file.type || 'application/octet-stream',
        file_size: file.size,
        data: base64,
      });
    };
    reader.readAsDataURL(file);
  });
}

// In-memory draft cache: persists input text per-conversation across component unmounts
const _draftCache = new Map<string, string>();

export function InputArea() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [value, setValue] = useState(() => {
    const convId = useConversationStore.getState().activeConversationId;
    return convId ? _draftCache.get(convId) || '' : '';
  });
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [voiceCallVisible, setVoiceCallVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mcpPopoverOpen, setMcpPopoverOpen] = useState(false);
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const prevConvIdRef = useRef<string | null>(
    useConversationStore.getState().activeConversationId ?? null
  );

  // Drag-to-resize state: userMinHeight controls the minimum visible height of the textarea
  const INITIAL_MIN_HEIGHT = 44;
  const ABSOLUTE_MAX_HEIGHT = 600;
  const [userMinHeight, setUserMinHeight] = useState(INITIAL_MIN_HEIGHT);
  const userMinHeightRef = useRef(userMinHeight);
  userMinHeightRef.current = userMinHeight;
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Multi-model companion state
  const [companionModels, setCompanionModels] = useState<Array<{ providerId: string; modelId: string }>>([]);
  const [multiModelOpen, setMultiModelOpen] = useState(false);
  const sendMultiModelMessage = useConversationStore((s) => s.sendMultiModelMessage);

  const { message: messageApi, modal } = App.useApp();
  const streaming = useConversationStore((s) => s.streaming);
  const compressing = useConversationStore((s) => s.compressing);
  const cancelCurrentStream = useConversationStore((s) => s.cancelCurrentStream);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const sendAgentMessage = useConversationStore((s) => s.sendAgentMessage);
  const createConversation = useConversationStore((s) => s.createConversation);
  const messages = useConversationStore((s) => s.messages);
  const totalActiveCount = useConversationStore((s) => s.totalActiveCount);
  const hasOlderMessages = useConversationStore((s) => s.hasOlderMessages);
  const contextCount = useMemo(() => {
    const activeMessages = messages.filter((m) => m.is_active !== false && !m.content.startsWith('%%ERROR%%'));
    const lastMarkerIdx = activeMessages.reduce((maxIdx, m, i) => {
      if (m.content === '<!-- context-clear -->' || m.content === '<!-- context-compressed -->') return i;
      return maxIdx;
    }, -1);
    if (lastMarkerIdx !== -1) {
      return activeMessages.slice(lastMarkerIdx + 1).length;
    }
    if (hasOlderMessages && totalActiveCount > 0) {
      return totalActiveCount;
    }
    return activeMessages.length;
  }, [messages, hasOlderMessages, totalActiveCount]);

  const conversations = useConversationStore((s) => s.conversations);
  const providers = useProviderStore((s) => s.providers);
  const settings = useSettingsStore((s) => s.settings);

  const shortcutHint = useCallback((label: string, action: ShortcutAction) => {
    if (!settings) return label;
    const binding = getShortcutBinding(settings, action);
    return `${label} (${formatShortcutForDisplay(binding)})`;
  }, [settings]);

  // Search state
  const searchEnabled = useConversationStore((s) => s.searchEnabled);
  const searchProviderId = useConversationStore((s) => s.searchProviderId);
  const setSearchEnabled = useConversationStore((s) => s.setSearchEnabled);
  const setSearchProviderId = useConversationStore((s) => s.setSearchProviderId);
  const searchProviders = useSearchStore((s) => s.providers);
  const loadSearchProviders = useSearchStore((s) => s.loadProviders);

  // MCP state
  const mcpServers = useMcpStore((s) => s.servers);
  const loadMcpServers = useMcpStore((s) => s.loadServers);
  const enabledMcpServerIds = useConversationStore((s) => s.enabledMcpServerIds);
  const toggleMcpServer = useConversationStore((s) => s.toggleMcpServer);

  // Thinking state
  const thinkingBudget = useConversationStore((s) => s.thinkingBudget);
  const setThinkingBudget = useConversationStore((s) => s.setThinkingBudget);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);

  // Agent permission mode state
  const [agentPermissionMode, setAgentPermissionMode] = useState<string>('default');

  // Agent working directory state
  const [agentCwd, setAgentCwd] = useState<string | null>(null);

  // Knowledge base state
  const knowledgeBases = useKnowledgeStore((s) => s.bases);
  const loadKnowledgeBases = useKnowledgeStore((s) => s.loadBases);
  const enabledKnowledgeBaseIds = useConversationStore((s) => s.enabledKnowledgeBaseIds);
  const toggleKnowledgeBase = useConversationStore((s) => s.toggleKnowledgeBase);
  const [kbPopoverOpen, setKbPopoverOpen] = useState(false);

  // Memory state
  const memoryNamespaces = useMemoryStore((s) => s.namespaces);
  const loadMemoryNamespaces = useMemoryStore((s) => s.loadNamespaces);
  const enabledMemoryNamespaceIds = useConversationStore((s) => s.enabledMemoryNamespaceIds);
  const toggleMemoryNamespace = useConversationStore((s) => s.toggleMemoryNamespace);
  const [memoryPopoverOpen, setMemoryPopoverOpen] = useState(false);

  // Context clear
  const insertContextClear = useConversationStore((s) => s.insertContextClear);
  const clearAllMessages = useConversationStore((s) => s.clearAllMessages);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const compressContext = useConversationStore((s) => s.compressContext);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const currentMode = activeConversation?.mode || 'chat';

  const setActivePage = useUIStore((s) => s.setActivePage);
  const setSettingsSection = useUIStore((s) => s.setSettingsSection);

  // Load search providers on mount
  useEffect(() => {
    if (searchProviders.length === 0) loadSearchProviders();
  }, [searchProviders.length, loadSearchProviders]);

  // Load MCP servers on mount
  useEffect(() => {
    if (mcpServers.length === 0) loadMcpServers();
  }, [mcpServers.length, loadMcpServers]);

  // Load knowledge bases on mount
  useEffect(() => {
    if (knowledgeBases.length === 0) loadKnowledgeBases();
  }, [knowledgeBases.length, loadKnowledgeBases]);

  // Load memory namespaces on mount
  useEffect(() => {
    if (memoryNamespaces.length === 0) loadMemoryNamespaces();
  }, [memoryNamespaces.length, loadMemoryNamespaces]);

  // Fetch agent permission mode on mount/conversation switch
  useEffect(() => {
    if (currentMode === 'agent' && activeConversationId) {
      invoke('agent_get_session', { conversationId: activeConversationId })
        .then((session: any) => {
          if (session) {
            setAgentPermissionMode(session.permission_mode || 'default');
            setAgentCwd(session.cwd || null);
          }
        })
        .catch(() => {});
    }
  }, [currentMode, activeConversationId]);

  // Draft persistence: save old draft & restore new when conversation changes
  useEffect(() => {
    const prev = prevConvIdRef.current;
    if (prev && prev !== activeConversationId) {
      const draft = valueRef.current;
      if (draft) _draftCache.set(prev, draft);
      else _draftCache.delete(prev);
    }
    setValue(activeConversationId ? _draftCache.get(activeConversationId) || '' : '');
    prevConvIdRef.current = activeConversationId ?? null;
  }, [activeConversationId]);

  // Save draft on unmount (navigating away from chat page)
  useEffect(() => {
    return () => {
      const convId = prevConvIdRef.current;
      if (convId && valueRef.current) {
        _draftCache.set(convId, valueRef.current);
      }
    };
  }, []);

  // Persist companion models per conversation in localStorage
  const companionStorageKey = activeConversationId ? `aqbot:companion-models:${activeConversationId}` : null;

  // Load companion models when conversation changes
  useEffect(() => {
    if (!companionStorageKey) { setCompanionModels([]); return; }
    try {
      const saved = localStorage.getItem(companionStorageKey);
      setCompanionModels(saved ? JSON.parse(saved) : []);
    } catch { setCompanionModels([]); }
  }, [companionStorageKey]);

  // Pick up pending prompt text from welcome cards and send through the proper pipeline
  const pendingPromptText = useConversationStore((s) => s.pendingPromptText);
  useEffect(() => {
    if (!pendingPromptText) return;
    useConversationStore.getState().setPendingPromptText(null);
    const text = pendingPromptText;
    (async () => {
      try {
        if (companionModels.length > 0) {
          await sendMultiModelMessage(text, companionModels, undefined, searchEnabled ? searchProviderId : null);
        } else {
          await sendMessage(text, undefined, searchEnabled ? searchProviderId : null);
        }
      } catch (e) {
        console.error('[InputArea] pendingPromptText send error:', e);
        messageApi.error(String(e));
      }
    })();
  }, [pendingPromptText]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search dropdown menu items
  const searchMenuItems = useMemo(() => {
    const available = searchProviders;
    if (available.length === 0) {
      return [
        {
          key: '__empty',
          label: (
            <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
              {t('chat.search.noProviders')}
            </span>
          ),
          disabled: true,
        },
      ];
    }
    return available.map((p) => ({
      key: p.id,
      label: (
        <div className="flex items-center gap-2" style={{ minWidth: 140 }}>
          <Tag
            color="blue"
            style={{ margin: 0, fontSize: 11, lineHeight: '18px', padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
          >
            <SearchProviderTypeIcon type={p.providerType} size={14} />
            {PROVIDER_TYPE_LABELS[p.providerType] || p.providerType}
          </Tag>
          <span className="flex-1" style={{ fontSize: 13 }}>{p.name}</span>
          {searchEnabled && searchProviderId === p.id && (
            <Check size={14} style={{ color: token.colorPrimary }} />
          )}
        </div>
      ),
    }));
  }, [searchProviders, searchEnabled, searchProviderId, token, t]);

  const handleSearchMenuClick = useCallback(
    ({ key }: { key: string }) => {
      if (key === '__empty') return;
      setSearchEnabled(true);
      setSearchProviderId(key);
    },
    [setSearchEnabled, setSearchProviderId],
  );

  // MCP popover content — grouped by builtin/custom with checkboxes
  const mcpPopoverContent = useMemo(() => {
    const enabledServers = mcpServers.filter((s) => s.enabled);
    if (enabledServers.length === 0) {
      return (
        <div style={{ padding: '8px 0', minWidth: 180 }}>
          <div style={{ color: token.colorTextSecondary, fontSize: 12, marginBottom: 8 }}>
            {t('chat.mcp.noServers')}
          </div>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, fontSize: 12 }}
            onClick={() => {
              setMcpPopoverOpen(false);
              setSettingsSection('mcpServers');
              setActivePage('settings');
            }}
          >
            {t('chat.mcp.goConfig')}
          </Button>
        </div>
      );
    }

    const builtinServers = enabledServers.filter((s) => s.source === 'builtin');
    const customServers = enabledServers.filter((s) => s.source === 'custom');

    const renderGroup = (title: string, servers: typeof mcpServers) => (
      <div key={title}>
        <div style={{ fontSize: 11, color: token.colorTextSecondary, padding: '4px 0', fontWeight: 600 }}>
          {title}
        </div>
        {servers.map((server) => (
          <div key={server.id} style={{ padding: '3px 0' }}>
            <Checkbox
              checked={enabledMcpServerIds.includes(server.id)}
              onChange={() => toggleMcpServer(server.id)}
            >
              <span style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <McpServerIcon server={server} size={18} />
                {server.name}
              </span>
            </Checkbox>
          </div>
        ))}
      </div>
    );

    return (
      <div style={{ minWidth: 180, maxHeight: 300, overflowY: 'auto' }}>
        {builtinServers.length > 0 && renderGroup(t('settings.mcp.builtin'), builtinServers)}
        {builtinServers.length > 0 && customServers.length > 0 && (
          <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, margin: '6px 0' }} />
        )}
        {customServers.length > 0 && renderGroup(t('settings.mcp.custom'), customServers)}
      </div>
    );
  }, [mcpServers, enabledMcpServerIds, toggleMcpServer, token, t]);

  const thinkingOptions = useMemo(() => ([
    { key: 'default', label: t('chat.thinking.default'), value: null },
    { key: 'none', label: t('chat.thinking.none'), value: 0 },
    { key: 'low', label: t('chat.thinking.low'), value: 1024 },
    { key: 'medium', label: t('chat.thinking.medium'), value: 4096 },
    { key: 'high', label: t('chat.thinking.high'), value: 8192 },
    { key: 'xhigh', label: t('chat.thinking.xhigh'), value: 16384 },
  ]), [t]);

  const selectedThinkingOption = useMemo(
    () => thinkingOptions.find((opt) => opt.value === thinkingBudget) ?? thinkingOptions[0],
    [thinkingBudget, thinkingOptions],
  );

  const thinkingIcon = useMemo(() => {
    switch (selectedThinkingOption.key) {
      case 'none': return <CircleOff size={14} />;
      case 'low': return <SignalLow size={14} />;
      case 'medium': return <SignalMedium size={14} />;
      case 'high': return <SignalHigh size={14} />;
      case 'xhigh': return <Signal size={14} />;
      default: return <Atom size={14} />;
    }
  }, [selectedThinkingOption.key]);

  const thinkingMenuItems = useMemo<MenuProps['items']>(
    () => thinkingOptions.map((opt) => ({
      key: opt.key,
      label: opt.label,
      icon: (() => {
        switch (opt.key) {
          case 'none': return <CircleOff size={14} />;
          case 'default': return <Atom size={14} />;
          case 'low': return <SignalLow size={14} />;
          case 'medium': return <SignalMedium size={14} />;
          case 'high': return <SignalHigh size={14} />;
          case 'xhigh': return <Signal size={14} />;
          default: return <Atom size={14} />;
        }
      })(),
    })),
    [thinkingOptions],
  );

  const handleThinkingMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(
    ({ key }) => {
      const selected = thinkingOptions.find((opt) => opt.key === key);
      if (!selected) return;
      setThinkingBudget(selected.value);
      setThinkingDropdownOpen(false);
    },
    [setThinkingBudget, thinkingOptions],
  );

  // Agent permission mode menu items
  const permissionModeItems = useMemo<MenuProps['items']>(() => [
    {
      key: 'default',
      label: t('common.permissionDefault'),
      icon: <Shield size={14} />,
    },
    {
      key: 'accept_edits',
      label: t('common.permissionAcceptEdits'),
      icon: <ShieldCheck size={14} style={{ color: '#1890ff' }} />,
    },
    {
      key: 'full_access',
      label: t('common.permissionFullAccess'),
      icon: <ShieldAlert size={14} style={{ color: '#ff4d4f' }} />,
    },
  ], [t]);

  const handlePermissionModeChange = useCallback(async (mode: string) => {
    if (!activeConversationId) return;

    const applyChange = async () => {
      try {
        await invoke('agent_update_session', {
          conversationId: activeConversationId,
          permissionMode: mode,
        });
        setAgentPermissionMode(mode);
      } catch (e) {
        console.warn('Failed to update permission mode:', e);
      }
    };

    if (mode === 'accept_edits' || mode === 'full_access') {
      const isFullAccess = mode === 'full_access';
      modal.confirm({
        title: isFullAccess
          ? t('agent.permissionFullAccessWarningTitle', '⚠️ 完全访问模式')
          : t('agent.permissionAcceptEditsWarningTitle', '⚠️ 允许编辑模式'),
        content: isFullAccess
          ? t('agent.permissionFullAccessWarning', 'Agent 将拥有完全访问权限，可以执行任何文件操作且不受路径限制。请确保你信任当前使用的模型和 System Prompt。')
          : t('agent.permissionAcceptEditsWarning', 'Agent 将自动批准文件编辑操作，无需逐一确认。请确保你了解潜在的安全风险。'),
        okText: t('common.confirm', '确认'),
        cancelText: t('common.cancel', '取消'),
        okButtonProps: isFullAccess ? { danger: true } : undefined,
        onOk: applyChange,
      });
    } else {
      await applyChange();
    }
  }, [activeConversationId, t]);

  const permissionModeIcon = useMemo(() => {
    switch (agentPermissionMode) {
      case 'accept_edits': return <ShieldCheck size={14} style={{ color: '#1890ff' }} />;
      case 'full_access': return <ShieldAlert size={14} style={{ color: '#ff4d4f' }} />;
      default: return <Shield size={14} />;
    }
  }, [agentPermissionMode]);

  const permissionModeLabel = useMemo(() => {
    switch (agentPermissionMode) {
      case 'accept_edits': return t('common.permissionAcceptEdits');
      case 'full_access': return t('common.permissionFullAccess');
      default: return t('common.permissionDefault');
    }
  }, [agentPermissionMode, t]);

  // Agent CWD helpers
  const abbreviatePath = useCallback((path: string): string => {
    const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segments.length <= 2) return path;
    return '…/' + segments.slice(-2).join('/');
  }, []);

  const handleSelectCwd = useCallback(async () => {
    if (!activeConversationId) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('common.selectDirectory'),
      });
      if (selected && typeof selected === 'string') {
        await invoke('agent_update_session', {
          conversationId: activeConversationId,
          cwd: selected,
        });
        setAgentCwd(selected);
      }
    } catch (e) {
      console.warn('Failed to select working directory:', e);
    }
  }, [activeConversationId, t]);

  // Knowledge base popover content
  const kbPopoverContent = useMemo(() => {
    if (knowledgeBases.length === 0) {
      return (
        <div style={{ padding: '8px 0', minWidth: 180 }}>
          <div style={{ color: token.colorTextSecondary, fontSize: 12, marginBottom: 8 }}>
            {t('chat.knowledge.empty')}
          </div>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, fontSize: 12 }}
            onClick={() => {
              setKbPopoverOpen(false);
              setActivePage('knowledge');
            }}
          >
            {t('chat.mcp.goConfig')}
          </Button>
        </div>
      );
    }
    return (
      <div style={{ minWidth: 180, maxHeight: 300, overflowY: 'auto' }}>
        {knowledgeBases.map((kb) => (
          <div key={kb.id} style={{ padding: '3px 0' }}>
            <Checkbox
              checked={enabledKnowledgeBaseIds.includes(kb.id)}
              onChange={() => toggleKnowledgeBase(kb.id)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <KnowledgeBaseIcon kb={kb} size={14} />
                {kb.name}
              </span>
            </Checkbox>
          </div>
        ))}
      </div>
    );
  }, [knowledgeBases, enabledKnowledgeBaseIds, toggleKnowledgeBase, token, t, setActivePage]);

  // Memory namespace popover content
  const memoryPopoverContent = useMemo(() => {
    if (memoryNamespaces.length === 0) {
      return (
        <div style={{ padding: '8px 0', minWidth: 180 }}>
          <div style={{ color: token.colorTextSecondary, fontSize: 12, marginBottom: 8 }}>
            {t('chat.memory.empty')}
          </div>
          <Button
            type="link"
            size="small"
            style={{ padding: 0, fontSize: 12 }}
            onClick={() => {
              setMemoryPopoverOpen(false);
              setActivePage('memory');
            }}
          >
            {t('chat.mcp.goConfig')}
          </Button>
        </div>
      );
    }
    return (
      <div style={{ minWidth: 180, maxHeight: 300, overflowY: 'auto' }}>
        {memoryNamespaces.map((ns) => (
          <div key={ns.id} style={{ padding: '3px 0' }}>
            <Checkbox
              checked={enabledMemoryNamespaceIds.includes(ns.id)}
              onChange={() => toggleMemoryNamespace(ns.id)}
            >
              <span style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <NamespaceIcon ns={ns} size={16} />
                {ns.name}
              </span>
            </Checkbox>
          </div>
        ))}
      </div>
    );
  }, [memoryNamespaces, enabledMemoryNamespaceIds, toggleMemoryNamespace, token, t, setActivePage]);

  const currentModel = React.useMemo(() => {
    if (activeConversation) {
      return findModelByIds(providers, activeConversation.provider_id, activeConversation.model_id);
    }

    if (settings.default_provider_id && settings.default_model_id) {
      const defaultModel = findModelByIds(providers, settings.default_provider_id, settings.default_model_id);
      if (defaultModel?.enabled) return defaultModel;
    }

    for (const provider of providers) {
      if (!provider.enabled) continue;
      const model = provider.models.find((item) => item.enabled);
      if (model) return model;
    }

    return null;
  }, [activeConversation, providers, settings.default_provider_id, settings.default_model_id]);

  // Context token usage calculation
  const getCompressionSummary = useConversationStore((s) => s.getCompressionSummary);
  const [summaryTokenCount, setSummaryTokenCount] = useState<number>(0);

  useEffect(() => {
    if (!activeConversationId || !activeConversation?.context_compression) {
      setSummaryTokenCount(0);
      return;
    }
    getCompressionSummary(activeConversationId).then((s) => {
      setSummaryTokenCount(s?.token_count ?? 0);
    });
  }, [activeConversationId, activeConversation?.context_compression, getCompressionSummary, messages]);

  // TODO: Token estimation only considers loaded messages. When hasOlderMessages is true
  // and no context-clear marker is found, the token estimate will be lower than actual.
  // A proper fix would require the backend to return total token counts.
  const contextTokenUsage = useMemo(() => {
    const maxTokens = currentModel?.max_tokens;
    if (!maxTokens) return null;

    // Count message tokens (only after last marker)
    const activeMessages = messages.filter((m) => m.is_active !== false && !m.content.startsWith('%%ERROR%%'));
    const lastMarkerIdx = activeMessages.reduce((maxIdx, m, i) => {
      if (m.content === '<!-- context-clear -->' || m.content === '<!-- context-compressed -->') return i;
      return maxIdx;
    }, -1);
    const effectiveMessages = lastMarkerIdx === -1 ? activeMessages : activeMessages.slice(lastMarkerIdx + 1);
    let usedTokens = effectiveMessages.reduce(
      (sum, m) => sum + estimateMessageTokens(m.role, m.content), 0,
    );

    // Add system prompt
    if (activeConversation?.system_prompt) {
      usedTokens += estimateTokens(activeConversation.system_prompt) + 4;
    }

    // Add summary tokens
    usedTokens += summaryTokenCount;

    const percent = Math.min(Math.round((usedTokens / maxTokens) * 100), 100);
    return { usedTokens, maxTokens, percent };
  }, [messages, currentModel?.max_tokens, activeConversation?.system_prompt, summaryTokenCount]);

  const { hasRealtimeVoice, hasReasoning, hasVision } = React.useMemo(() => ({
    hasRealtimeVoice: activeConversation
      ? !!findModelByIds(providers, activeConversation.provider_id, activeConversation.model_id)?.capabilities.includes('RealtimeVoice')
      : false,
    hasReasoning: supportsReasoning(currentModel),
    hasVision: modelHasCapability(currentModel, 'Vision'),
  }), [activeConversation, currentModel, providers]);

  // Current model key for excluding from multi-select (no longer used - users can select any model)

  const companionDisplayInfos = useMemo(() => {
    return companionModels.map((cm) => {
      const provider = providers.find((p) => p.id === cm.providerId);
      const model = provider?.models.find((m) => m.model_id === cm.modelId);
      return {
        ...cm,
        modelName: model?.name ?? cm.modelId,
        providerName: provider?.name ?? '',
      };
    });
  }, [companionModels, providers]);

  const handleMultiModelSelect = useCallback((models: Array<{ providerId: string; modelId: string }>) => {
    setCompanionModels(models);
    if (companionStorageKey) {
      if (models.length > 0) {
        localStorage.setItem(companionStorageKey, JSON.stringify(models));
      } else {
        localStorage.removeItem(companionStorageKey);
      }
    }
  }, [companionStorageKey]);

  const removeCompanionModel = useCallback((index: number) => {
    setCompanionModels((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (companionStorageKey) {
        if (next.length > 0) {
          localStorage.setItem(companionStorageKey, JSON.stringify(next));
        } else {
          localStorage.removeItem(companionStorageKey);
        }
      }
      return next;
    });
  }, [companionStorageKey]);

  const clearAllCompanionModels = useCallback(() => {
    setCompanionModels([]);
    if (companionStorageKey) localStorage.removeItem(companionStorageKey);
  }, [companionStorageKey]);

  const voiceConfig: RealtimeConfig = React.useMemo(
    () => ({
      model_id: activeConversation?.model_id ?? '',
      voice: null,
      audio_format: { sample_rate: 24000, channels: 1, encoding: 'Pcm16' },
    }),
    [activeConversation?.model_id],
  );

  const handleModeSwitch = useCallback(async (mode: 'chat' | 'agent') => {
    if (!activeConversation) return;

    await updateConversation(activeConversation.id, { mode });

    if (mode === 'agent') {
      // Clear multi-model companion models — not applicable in agent mode
      if (companionModels.length > 0) {
        setCompanionModels([]);
        if (companionStorageKey) localStorage.removeItem(companionStorageKey);
      }
      try {
        const session = await invoke<{ cwd: string | null }>('agent_update_session', {
          conversationId: activeConversation.id,
        });
        if (!session.cwd) {
          const workspacePath = await invoke<string>('agent_ensure_workspace', {
            conversationId: activeConversation.id,
          });
          await invoke('agent_update_session', {
            conversationId: activeConversation.id,
            cwd: workspacePath,
          });
          setAgentCwd(workspacePath);
        } else {
          setAgentCwd(session.cwd);
        }
      } catch (e) {
        console.warn('Failed to init agent session:', e);
      }
    }
  }, [activeConversation, updateConversation, companionModels, companionStorageKey]);

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;

    const submittedFiles = attachedFiles;

    try {
      if (!activeConversationId) {
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
          messageApi.warning(t('chat.noModelsAvailable'));
          return;
        }
        await createConversation(trimmed.slice(0, 30), model.model_id, provider.id);
      }

      let attachments: AttachmentInput[] | undefined;
      if (submittedFiles.length > 0) {
        attachments = await Promise.all(submittedFiles.map(fileToAttachmentInput));
      }

      setValue('');
      setAttachedFiles([]);
      // Reset textarea height after clearing content
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      });
      if (currentMode === 'agent') {
        await sendAgentMessage(trimmed, attachments);
      } else if (companionModels.length > 0) {
        await sendMultiModelMessage(trimmed, companionModels, attachments, searchEnabled ? searchProviderId : null);
      } else {
        await sendMessage(trimmed, attachments, searchEnabled ? searchProviderId : null);
      }
    } catch (e) {
      setValue((current) => current || trimmed);
      setAttachedFiles((current) => (current.length > 0 ? current : submittedFiles));
      console.error('[handleSend] error:', e);
      messageApi.error(String(e));
      // Re-expand textarea after restoring content
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.style.height = 'auto';
          const desired = Math.max(textarea.scrollHeight, userMinHeightRef.current);
          textarea.style.height = Math.min(desired, ABSOLUTE_MAX_HEIGHT) + 'px';
        }
      });
    }
  }, [value, attachedFiles, sendMessage, sendAgentMessage, sendMultiModelMessage, companionModels, activeConversationId, providers, settings, createConversation, messageApi, t, searchEnabled, searchProviderId, currentMode]);

  const handleFillLastMessage = useCallback(() => {
    if (streaming) return;
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'user' && message.status !== 'error');
    if (!lastUserMessage?.content) return;
    setValue(lastUserMessage.content);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.style.height = 'auto';
      const desired = Math.max(textarea.scrollHeight, userMinHeightRef.current);
      textarea.style.height = Math.min(desired, ABSOLUTE_MAX_HEIGHT) + 'px';
    });
  }, [messages, streaming]);

  const handleCancel = useCallback(() => {
    cancelCurrentStream();
  }, [cancelCurrentStream]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      setAttachedFiles((prev) => [...prev, ...Array.from(files)]);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const removeFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!hasVision) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      setAttachedFiles((prev) => [...prev, ...files]);
    }
  }, [hasVision]);

  // Drag-and-drop overlay (Tauri native)
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!hasVision) return;

    let unlisten: (() => void) | undefined;

    (async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const { readFile } = await import('@tauri-apps/plugin-fs');

      unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        const { type } = event.payload;
        if (type === 'enter') {
          setIsDragging(true);
        } else if (type === 'leave') {
          setIsDragging(false);
        } else if (type === 'drop') {
          setIsDragging(false);
          const { paths } = event.payload;
          const files: File[] = [];
          for (const filePath of paths) {
            try {
              const fileName = filePath.split(/[\\/]/).pop() || 'file';
              const ext = fileName.split('.').pop()?.toLowerCase() || '';
              const mimeMap: Record<string, string> = {
                png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
                bmp: 'image/bmp', ico: 'image/x-icon',
                pdf: 'application/pdf', txt: 'text/plain',
                json: 'application/json', csv: 'text/csv',
                md: 'text/markdown', html: 'text/html',
                js: 'text/javascript', ts: 'text/typescript',
                zip: 'application/zip',
              };
              const mimeType = mimeMap[ext] || 'application/octet-stream';
              const bytes = await readFile(filePath);
              files.push(new File([bytes], fileName, { type: mimeType }));
            } catch (err) {
              console.error('[drag-drop] Failed to read file:', filePath, err);
            }
          }
          if (files.length > 0) {
            setAttachedFiles((prev) => [...prev, ...files]);
          }
        }
      });
    })();

    return () => {
      unlisten?.();
    };
  }, [hasVision]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing || e.key === 'Process' || e.keyCode === 229) {
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-resize textarea: height = max(userMinHeight, contentHeight), capped at ABSOLUTE_MAX
  const autoResizeTextarea = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    const desired = Math.max(el.scrollHeight, userMinHeightRef.current);
    el.style.height = Math.min(desired, ABSOLUTE_MAX_HEIGHT) + 'px';
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    autoResizeTextarea(e.target);
  }, [autoResizeTextarea]);

  // Drag-to-resize: changes userMinHeight so the textarea grows even with short content
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const textarea = textareaRef.current;
    const startHeight = textarea ? textarea.offsetHeight : userMinHeightRef.current;
    dragStateRef.current = { startY: e.clientY, startH: startHeight };
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStateRef.current) return;
      const delta = dragStateRef.current.startY - ev.clientY;
      const newH = Math.max(INITIAL_MIN_HEIGHT, Math.min(ABSOLUTE_MAX_HEIGHT, dragStateRef.current.startH + delta));
      setUserMinHeight(newH);
      userMinHeightRef.current = newH;
      if (textarea) {
        textarea.style.height = 'auto';
        const desired = Math.max(textarea.scrollHeight, newH);
        textarea.style.height = Math.min(desired, ABSOLUTE_MAX_HEIGHT) + 'px';
      }
    };
    const onMouseUp = () => {
      dragStateRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // Listen for Escape to close voice overlay
  React.useEffect(() => {
    const onEscape = () => setVoiceCallVisible(false);
    window.addEventListener('aqbot:escape', onEscape);
    return () => window.removeEventListener('aqbot:escape', onEscape);
  }, []);

  React.useEffect(() => {
    const onFillLast = () => handleFillLastMessage();
    const onClearContext = () => {
      if (activeConversationId && !streaming) {
        void insertContextClear();
      }
    };
    const onClearConversation = () => {
      if (!activeConversationId || streaming || messages.length === 0) return;
      modal.confirm({
        title: t('chat.clearConversationConfirmTitle'),
        content: t('chat.clearConversationConfirmContent'),
        okButtonProps: { danger: true },
        okText: t('common.confirm'),
        cancelText: t('common.cancel'),
        onOk: async () => {
          await clearAllMessages();
        },
      });
    };

    window.addEventListener('aqbot:fill-last-message', onFillLast);
    window.addEventListener('aqbot:clear-context', onClearContext);
    window.addEventListener('aqbot:clear-conversation-messages', onClearConversation);
    return () => {
      window.removeEventListener('aqbot:fill-last-message', onFillLast);
      window.removeEventListener('aqbot:clear-context', onClearContext);
      window.removeEventListener('aqbot:clear-conversation-messages', onClearConversation);
    };
  }, [
    activeConversationId,
    clearAllMessages,
    handleFillLastMessage,
    insertContextClear,
    messages.length,
    modal,
    streaming,
    t,
  ]);

  // Listen for "fill input" events from GlobalCopyMenu
  React.useEffect(() => {
    const onFillInput = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (typeof text !== 'string' || !text) return;
      setValue((prev) => (prev ? prev + '\n' + text : text));
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.style.height = 'auto';
        const desired = Math.max(textarea.scrollHeight, userMinHeightRef.current);
        textarea.style.height = Math.min(desired, ABSOLUTE_MAX_HEIGHT) + 'px';
      });
    };
    window.addEventListener('aqbot:fill-input', onFillInput);
    return () => window.removeEventListener('aqbot:fill-input', onFillInput);
  }, []);

  // Listen for mode toggle shortcut
  React.useEffect(() => {
    const onToggleMode = () => {
      const nextMode = currentMode === 'chat' ? 'agent' : 'chat';
      handleModeSwitch(nextMode);
    };
    window.addEventListener('aqbot:toggle-mode', onToggleMode);
    return () => window.removeEventListener('aqbot:toggle-mode', onToggleMode);
  }, [currentMode, handleModeSwitch]);

  return (
    <div className="px-4 pb-3 pt-1">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Attachment preview */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachedFiles.map((file, idx) => (
            <span
              key={`${file.name}-${idx}`}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs"
              style={{
                backgroundColor: token.colorFillTertiary,
                borderRadius: token.borderRadius,
              }}
            >
              {file.name}
              <Trash2
                size={14}
                className="cursor-pointer"
                style={{ color: token.colorTextSecondary }}
                onClick={() => removeFile(idx)}
              />
            </span>
          ))}
        </div>
      )}

      {/* Main input container */}
      <div
        ref={containerRef}
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: 16,
          backgroundColor: token.colorBgContainer,
          overflow: 'hidden',
        }}
      >
        {/* Drag-to-resize handle */}
        <div
          onMouseDown={handleResizeMouseDown}
          style={{
            height: 10,
            cursor: 'ns-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <GripHorizontal size={14} style={{ color: token.colorTextQuaternary, opacity: 0.5 }} />
        </div>
        {/* Companion model tags */}
        {currentMode !== 'agent' && companionModels.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3 pb-1">
            <span
              className="inline-flex items-center px-2 py-0.5 text-xs"
              style={{ color: token.colorTextTertiary }}
            >
              {t('chat.multiModel.selectTitle')}:
            </span>
            {companionDisplayInfos.map((cm, idx) => (
              <span
                key={`${cm.providerId}-${cm.modelId}`}
                className="inline-flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 text-xs"
                style={{
                  backgroundColor: token.colorFillSecondary,
                  borderRadius: token.borderRadiusSM,
                  color: token.colorText,
                }}
              >
                <ModelIcon model={cm.modelId} size={14} type="avatar" />
                <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {cm.modelName}
                </span>
                {cm.providerName && (
                  <span style={{ color: token.colorTextQuaternary, fontSize: 11 }}>
                    {cm.providerName}
                  </span>
                )}
                <X
                  size={12}
                  className="cursor-pointer flex-shrink-0"
                  style={{ color: token.colorTextTertiary }}
                  onClick={() => removeCompanionModel(idx)}
                />
              </span>
            ))}
            {/* Clear all companion models */}
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs cursor-pointer"
              style={{
                borderRadius: token.borderRadiusSM,
                color: token.colorTextTertiary,
              }}
              onClick={clearAllCompanionModels}
            >
              <Trash2 size={11} />
              {t('chat.clearAll')}
            </span>
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t('chat.inputPlaceholder')}
          rows={1}
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            resize: 'none',
            padding: '4px 16px 8px',
            fontSize: token.fontSize,
            lineHeight: 1.6,
            backgroundColor: 'transparent',
            color: token.colorText,
            fontFamily: 'inherit',
            minHeight: userMinHeight,
            maxHeight: ABSOLUTE_MAX_HEIGHT,
            overflowY: 'auto',
          }}
        />

        {/* Bottom action bar */}
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-0.5">
            {searchEnabled ? (
              <Tooltip title={t('chat.search.title')}>
                <Button
                  type="text"
                  size="small"
                  icon={<Globe size={14} />}
                  style={{ color: token.colorPrimary }}
                  onClick={() => {
                    setSearchEnabled(false);
                    setSearchProviderId(null);
                  }}
                />
              </Tooltip>
            ) : (
              <Dropdown
                trigger={['click']}
                placement="topLeft"
                menu={{ items: searchMenuItems, onClick: handleSearchMenuClick }}
                open={searchDropdownOpen}
                onOpenChange={setSearchDropdownOpen}
              >
                <Tooltip title={t('chat.search.title')} open={searchDropdownOpen ? false : undefined}>
                  <Button
                    type="text"
                    size="small"
                    icon={<Globe size={14} />}
                  />
                </Tooltip>
              </Dropdown>
            )}
            {hasReasoning && (
              <Dropdown
                trigger={['click']}
                placement="topLeft"
                menu={{
                  items: thinkingMenuItems,
                  onClick: handleThinkingMenuClick,
                  selectable: true,
                  selectedKeys: [selectedThinkingOption.key],
                }}
                open={thinkingDropdownOpen}
                onOpenChange={setThinkingDropdownOpen}
              >
                <Tooltip
                  title={`${t('chat.thinkingIntensity')}: ${selectedThinkingOption.label}`}
                  open={thinkingDropdownOpen ? false : undefined}
                >
                  <Button
                    type="text"
                    size="small"
                    icon={thinkingIcon}
                    style={
                      thinkingBudget === 0
                        ? { color: token.colorError }
                        : thinkingBudget !== null
                          ? { color: token.colorPrimary }
                          : undefined
                    }
                  />
                </Tooltip>
              </Dropdown>
            )}
            {hasVision && (
              <Tooltip title={t('chat.attachFile')}>
                <Button
                  type="text"
                  size="small"
                  icon={<Paperclip size={14} />}
                  onClick={handleFileSelect}
                />
              </Tooltip>
            )}
            <Popover
              trigger="click"
              placement="topLeft"
              content={mcpPopoverContent}
              arrow={false}
              open={mcpPopoverOpen}
              onOpenChange={setMcpPopoverOpen}
            >
              <Tooltip title={t('chat.mcp.title')} open={mcpPopoverOpen ? false : undefined}>
                <Badge count={enabledMcpServerIds.filter((id) => mcpServers.some((s) => s.id === id && s.enabled)).length} size="small" offset={[-4, 4]} color={token.colorPrimary}>
                <Button
                  type="text"
                  size="small"
                  icon={<Plug size={14} />}
                  style={enabledMcpServerIds.some((id) => mcpServers.some((s) => s.id === id && s.enabled)) ? { color: token.colorPrimary } : undefined}
                />
                </Badge>
              </Tooltip>
            </Popover>
            <Popover
              trigger="click"
              placement="topLeft"
              content={kbPopoverContent}
              arrow={false}
              open={kbPopoverOpen}
              onOpenChange={setKbPopoverOpen}
            >
              <Tooltip title={t('chat.knowledge.title')} open={kbPopoverOpen ? false : undefined}>
                <Badge count={enabledKnowledgeBaseIds.length} size="small" offset={[-4, 4]} color={token.colorPrimary}>
                <Button
                  type="text"
                  size="small"
                  icon={<BookOpen size={14} />}
                  style={enabledKnowledgeBaseIds.length > 0 ? { color: token.colorPrimary } : undefined}
                />
                </Badge>
              </Tooltip>
            </Popover>
            <Popover
              trigger="click"
              placement="topLeft"
              content={memoryPopoverContent}
              arrow={false}
              open={memoryPopoverOpen}
              onOpenChange={setMemoryPopoverOpen}
            >
              <Tooltip title={t('chat.memory.title')} open={memoryPopoverOpen ? false : undefined}>
                <Badge count={enabledMemoryNamespaceIds.length} size="small" offset={[-4, 4]} color={token.colorPrimary}>
                <Button
                  type="text"
                  size="small"
                  icon={<Brain size={14} />}
                  style={enabledMemoryNamespaceIds.length > 0 ? { color: token.colorPrimary } : undefined}
                />
                </Badge>
              </Tooltip>
            </Popover>
            {currentMode !== 'agent' && (
              <Tooltip title={t('chat.multiModel.selectTitle')}>
                <Button
                  type="text"
                  size="small"
                  icon={<GitCompareArrows size={14} />}
                  onClick={() => setMultiModelOpen(true)}
                  style={companionModels.length > 0 ? { color: token.colorPrimary } : undefined}
                />
              </Tooltip>
            )}
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'auto',
                    icon: activeConversation?.context_compression
                      ? <ZapOff size={14} />
                      : <Zap size={14} />,
                    label: activeConversation?.context_compression
                      ? t('chat.disableAutoCompression')
                      : t('chat.enableAutoCompression'),
                    onClick: () => {
                      if (!activeConversationId || !activeConversation) return;
                      updateConversation(activeConversationId, { context_compression: !activeConversation.context_compression });
                    },
                  },
                  {
                    key: 'manual',
                    icon: <Shrink size={14} />,
                    label: t('chat.manualCompress'),
                    disabled: !activeConversationId || streaming || compressing || messages.length === 0,
                    onClick: async () => {
                      if (!activeConversationId) return;
                      try {
                        await compressContext();
                        messageApi.success(t('chat.compressSuccess'));
                      } catch {
                        messageApi.error(t('chat.compressFailed'));
                      }
                    },
                  },
                ],
              }}
              trigger={['click']}
              placement="topLeft"
            >
              <Tooltip title={t('chat.contextCompression')}>
                <Button
                  type="text"
                  size="small"
                  icon={<Zap size={14} />}
                  loading={compressing}
                  disabled={!activeConversationId}
                  style={activeConversation?.context_compression ? { color: token.colorPrimary } : undefined}
                />
              </Tooltip>
            </Dropdown>
            <Tooltip title={shortcutHint(t('chat.clearContext'), 'clearContext')}>
              <Button
                type="text"
                size="small"
                icon={<Scissors size={14} />}
                onClick={insertContextClear}
                disabled={!activeConversationId || streaming || messages.length === 0 || messages[messages.length - 1]?.content === '<!-- context-clear -->'}
              />
            </Tooltip>
            <Tooltip title={shortcutHint(t('chat.clearConversation'), 'clearConversationMessages')}>
              <Button
                type="text"
                size="small"
                icon={<Eraser size={14} />}
                onClick={() => {
                  if (!activeConversationId) return;
                  modal.confirm({
                    title: t('chat.clearConversationConfirmTitle'),
                    content: t('chat.clearConversationConfirmContent'),
                    okButtonProps: { danger: true },
                    okText: t('common.confirm'),
                    cancelText: t('common.cancel'),
                    onOk: async () => {
                      await clearAllMessages();
                    },
                  });
                }}
                disabled={!activeConversationId || streaming || messages.length === 0}
              />
            </Tooltip>
            <Tooltip title={t('chat.conversationSettings')}>
              <Button type="text" size="small" icon={<SlidersHorizontal size={14} />} onClick={() => setSettingsOpen(true)} />
            </Tooltip>
            {hasRealtimeVoice && (
              <Tooltip title={t('voice.startCall') + '（暂未实现）'}>
                <Button
                  type="text"
                  size="small"
                  icon={<Mic size={14} />}
                  disabled
                />
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2">
            {streaming ? (
              <Button
                shape="circle"
                size="small"
                danger
                icon={<Square size={14} />}
                onClick={handleCancel}
              />
            ) : (
              <Button
                type="primary"
                shape="circle"
                size="small"
                icon={<ArrowUp size={14} />}
                onClick={handleSend}
                disabled={!value.trim()}
              />
            )}
          </div>
        </div>
      </div>

      {/* Mode controls bar — below input container */}
      <div className="flex items-center justify-between px-1 pt-1">
        <div className="flex items-center gap-1">
          <Dropdown
            menu={{
              items: [
                {
                  key: 'chat',
                  icon: <MessageSquare size={14} />,
                  label: t('common.chatMode'),
                },
                {
                  key: 'agent',
                  icon: <Bot size={14} />,
                  label: <>{t('common.agentMode')} <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginLeft: 2 }}>Beta</Tag></>,
                },
              ],
              selectedKeys: [currentMode],
              onClick: ({ key }) => handleModeSwitch(key as 'chat' | 'agent'),
            }}
            trigger={['click']}
          >
            <Button
              type="text"
              size="small"
              icon={currentMode === 'agent' ? <Bot size={14} /> : <MessageSquare size={14} />}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
            >
              {currentMode === 'agent' ? <>{t('common.agentMode')} <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginLeft: 2, marginRight: 0 }}>Beta</Tag></> : t('common.chatMode')}
            </Button>
          </Dropdown>
          {currentMode === 'agent' && (
            <Tooltip title={agentCwd || t('common.workingDirectory')}>
              <Button
                type="text"
                size="small"
                icon={<FolderOpen size={14} />}
                onClick={handleSelectCwd}
                style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 200, fontSize: 12 }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agentCwd ? abbreviatePath(agentCwd) : t('common.selectDirectory')}
                </span>
              </Button>
            </Tooltip>
          )}
          {currentMode === 'agent' && agentCwd && (
            <Tooltip title={t('common.openDirectory', '打开目录')}>
              <Button
                type="text"
                size="small"
                icon={<ExternalLink size={14} />}
                onClick={async () => {
                  try {
                    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
                    await revealItemInDir(agentCwd);
                  } catch (e) {
                    console.warn('Failed to open directory:', e);
                  }
                }}
                style={{ fontSize: 12, minWidth: 'auto', padding: '0 4px' }}
              />
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {currentMode === 'agent' && (
            <Dropdown
              menu={{
                items: permissionModeItems,
                selectedKeys: [agentPermissionMode],
                onClick: ({ key }) => handlePermissionModeChange(key),
              }}
              trigger={['click']}
              placement="topRight"
            >
              <Button
                type="text"
                size="small"
                icon={permissionModeIcon}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4, fontSize: 12,
                  ...(agentPermissionMode === 'full_access' ? { color: '#ff4d4f' } : {}),
                }}
              >
                {permissionModeLabel}
              </Button>
            </Dropdown>
          )}
          {contextCount > 0 && (
            <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
              {contextCount} {t('chat.contextMessages')}
            </span>
          )}
          {contextTokenUsage && (() => {
            const r = 8, stroke = 2.5, size = (r + stroke) * 2;
            const circ = 2 * Math.PI * r;
            const offset = circ * (1 - contextTokenUsage.percent / 100);
            const color = contextTokenUsage.percent > 80
              ? token.colorError
              : contextTokenUsage.percent > 60
                ? token.colorWarning
                : token.colorPrimary;
            return (
              <Popover
                content={
                  <span style={{ fontSize: 12 }}>
                    {contextTokenUsage.usedTokens.toLocaleString()} / {contextTokenUsage.maxTokens.toLocaleString()} tokens ({contextTokenUsage.percent}%)
                  </span>
                }
              >
                <svg width={size} height={size} style={{ display: 'block', cursor: 'pointer' }}>
                  <circle cx={r + stroke} cy={r + stroke} r={r} fill="none" stroke={token.colorBorderSecondary} strokeWidth={stroke} />
                  <circle
                    cx={r + stroke} cy={r + stroke} r={r}
                    fill="none" stroke={color} strokeWidth={stroke}
                    strokeDasharray={circ} strokeDashoffset={offset}
                    strokeLinecap="round"
                    transform={`rotate(-90 ${r + stroke} ${r + stroke})`}
                  />
                </svg>
              </Popover>
            );
          })()}
        </div>
      </div>

      <ConversationSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {hasRealtimeVoice && (
        <VoiceCall
          visible={voiceCallVisible}
          onClose={() => setVoiceCallVisible(false)}
          config={voiceConfig}
        />
      )}

      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              padding: '40px 60px',
              borderRadius: 16,
              border: `2px dashed ${token.colorPrimary}`,
              backgroundColor: token.colorBgElevated,
            }}
          >
            <Upload size={48} style={{ color: token.colorPrimary }} />
            <span style={{ fontSize: 16, fontWeight: 500, color: token.colorText }}>
              {t('chat.dropToAttach')}
            </span>
          </div>
        </div>
      )}

      {/* Multi-model selector (trigger hidden, controlled via multiModelOpen state) */}
      <ModelSelector
        multiSelect
        open={multiModelOpen}
        onOpenChange={setMultiModelOpen}
        onMultiSelect={handleMultiModelSelect}
        defaultSelectedModels={companionModels}
      >
        <span />
      </ModelSelector>
    </div>
  );
}
