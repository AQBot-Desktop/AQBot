import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Tag, Modal, Input, theme } from 'antd';
import { Search, Settings, Pin, PinOff } from 'lucide-react';
import { ModelIcon } from '@lobehub/icons';
import { useTranslation } from 'react-i18next';
import { useProviderStore, useConversationStore, useSettingsStore, useUIStore } from '@/stores';

const PINNED_MODELS_KEY = 'aqbot_pinned_models';

function loadPinnedModels(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_MODELS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePinnedModels(ids: string[]) {
  localStorage.setItem(PINNED_MODELS_KEY, JSON.stringify(ids));
}

interface ModelSelectorProps {
  style?: React.CSSProperties;
  /** Custom select callback. When provided, overrides the default conversation/settings update. */
  onSelect?: (providerId: string, modelId: string) => void;
  /** Override which model is highlighted as current (e.g. for per-message model switching). */
  overrideCurrentModel?: { providerId: string; modelId: string } | null;
  /** Custom trigger element. When provided, renders this instead of the default Tag. */
  children?: React.ReactNode;
  /** Controlled open state */
  open?: boolean;
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void;
}

export function ModelSelector({ style, onSelect, overrideCurrentModel, children, open: controlledOpen, onOpenChange }: ModelSelectorProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { providers } = useProviderStore();
  const { activeConversationId, conversations, updateConversation } =
    useConversationStore();
  const settings = useSettingsStore((s) => s.settings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = useCallback((v: boolean) => {
    if (onOpenChange) onOpenChange(v);
    if (!isControlled) setInternalOpen(v);
  }, [isControlled, onOpenChange]);
  const [search, setSearch] = useState('');
  const [pinnedModels, setPinnedModels] = useState<string[]>(loadPinnedModels);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const setActivePage = useUIStore((s) => s.setActivePage);
  const setSettingsSection = useUIStore((s) => s.setSettingsSection);
  const setSelectedProviderId = useUIStore((s) => s.setSelectedProviderId);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId),
    [conversations, activeConversationId],
  );

  const currentModel = useMemo(() => {
    let pid: string | undefined;
    let mid: string | undefined;
    if (activeConversation) {
      pid = activeConversation.provider_id;
      mid = activeConversation.model_id;
    } else if (settings.default_provider_id && settings.default_model_id) {
      pid = settings.default_provider_id;
      mid = settings.default_model_id;
    } else {
      for (const p of providers) {
        if (!p.enabled) continue;
        const m = p.models.find((m) => m.enabled);
        if (m) { pid = p.id; mid = m.model_id; break; }
      }
    }
    if (!pid || !mid) return null;
    const provider = providers.find((p) => p.id === pid);
    const model = provider?.models.find((m) => m.model_id === mid);
    return { pid, mid, name: model?.name ?? mid, providerName: provider?.name ?? '' };
  }, [activeConversation, settings.default_provider_id, settings.default_model_id, providers]);

  const currentValue = overrideCurrentModel
    ? `${overrideCurrentModel.providerId}::${overrideCurrentModel.modelId}`
    : currentModel ? `${currentModel.pid}::${currentModel.mid}` : undefined;

  // All enabled models flat list (for pinned section)
  const allEnabledModels = useMemo(() => {
    const result: { pid: string; mid: string; name: string; providerName: string }[] = [];
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        if (!m.enabled) continue;
        result.push({ pid: p.id, mid: m.model_id, name: m.name, providerName: p.name });
      }
    }
    return result;
  }, [providers]);

  // Pinned models resolved with search filter
  const pinnedItems = useMemo(() => {
    const q = search.toLowerCase().trim();
    return pinnedModels
      .map((key) => {
        const model = allEnabledModels.find((m) => `${m.pid}::${m.mid}` === key);
        return model ? { ...model, key } : null;
      })
      .filter((item): item is NonNullable<typeof item> =>
        item !== null && (!q || item.name.toLowerCase().includes(q) || item.mid.toLowerCase().includes(q)),
      );
  }, [pinnedModels, allEnabledModels, search]);

  // Filtered providers and models (excluding search)
  const filteredProviders = useMemo(() => {
    const q = search.toLowerCase().trim();
    return providers
      .filter((p) => p.enabled)
      .map((p) => ({
        ...p,
        models: p.models.filter(
          (m) => m.enabled && (!q || m.name.toLowerCase().includes(q) || m.model_id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)),
        ),
      }))
      .filter((p) => p.models.length > 0);
  }, [providers, search]);

  const handleSelect = useCallback(
    (providerId: string, modelId: string) => {
      if (onSelect) {
        onSelect(providerId, modelId);
      } else if (activeConversationId) {
        updateConversation(activeConversationId, {
          provider_id: providerId,
          model_id: modelId,
        });
      } else {
        saveSettings({ default_provider_id: providerId, default_model_id: modelId });
      }
      setOpen(false);
      setSearch('');
    },
    [activeConversationId, updateConversation, saveSettings, onSelect, setOpen],
  );

  const togglePin = useCallback((key: string) => {
    setPinnedModels((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      savePinnedModels(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onToggle = () => setOpen(!open);
    window.addEventListener('aqbot:toggle-model-selector', onToggle);
    return () => {
      window.removeEventListener('aqbot:toggle-model-selector', onToggle);
    };
  }, [open, setOpen]);

  const renderModelRow = (
    providerId: string,
    modelId: string,
    modelName: string,
    providerName: string,
    isPinned: boolean,
    showProviderTag: boolean,
  ) => {
    const key = `${providerId}::${modelId}`;
    const isActive = currentValue === key;
    const isHovered = hoveredKey === key;
    return (
      <div
        key={key}
        className="flex items-center gap-3 cursor-pointer"
        style={{
          backgroundColor: isActive ? token.colorPrimaryBg : isHovered ? token.colorFillSecondary : undefined,
          borderRadius: 8,
          margin: '0 8px',
          padding: '8px 12px',
          transition: 'background-color 0.15s',
        }}
        onClick={() => handleSelect(providerId, modelId)}
        onMouseEnter={() => setHoveredKey(key)}
        onMouseLeave={() => setHoveredKey(null)}
      >
        <ModelIcon model={modelId} size={22} type="avatar" />
        <span className="flex items-center gap-1.5" style={{ flex: 1, minWidth: 0 }}>
          {showProviderTag && providerName && (
            <Tag style={{ fontSize: 11, margin: 0, padding: '0 4px', lineHeight: '18px', flexShrink: 0, color: token.colorPrimary, backgroundColor: token.colorPrimaryBg, border: 'none' }}>{providerName}</Tag>
          )}
          <span style={{ fontSize: 14, color: isActive ? token.colorPrimary : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelName}</span>
        </span>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <span
            style={{ cursor: 'pointer', color: isPinned ? token.colorPrimary : token.colorTextQuaternary, fontSize: 14 }}
            onClick={() => togglePin(key)}
          >
            {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
          </span>
        </div>
      </div>
    );
  };

  return (
    <>
      {children ? (
        <span onClick={() => setOpen(true)}>{children}</span>
      ) : (
        <Tag
          onClick={() => setOpen(true)}
          style={{
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 10px',
            fontSize: 13,
            borderRadius: 6,
            ...style,
          }}
        >
          {currentModel && (
            <>
              <ModelIcon model={currentModel.mid} size={16} type="avatar" />
              {currentModel.providerName && (
                <Tag style={{ fontSize: 11, margin: 0, padding: '0 4px', lineHeight: '16px', color: token.colorPrimary, backgroundColor: token.colorPrimaryBg, border: 'none' }}>{currentModel.providerName}</Tag>
              )}
              <span>{currentModel.name}</span>
            </>
          )}
        </Tag>
      )}

      <Modal
        open={open}
        onCancel={() => { setOpen(false); setSearch(''); }}
        mask={{ enabled: true, blur: true }}
        footer={null}
        title={null}
        closable={false}
        width={480}
        styles={{
          body: { padding: 0, maxHeight: '60vh', display: 'flex', flexDirection: 'column' },
        }}
        style={{ borderRadius: 12 }}
      >
        {/* Search */}
        <div style={{ padding: '12px 16px 8px' }}>
          <Input
            prefix={<Search size={14} style={{ color: token.colorTextSecondary }} />}
            placeholder={t('chat.searchModelOrProvider', '搜索模型或服务商')}
            variant="borderless"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            style={{
              borderRadius: 8,
              backgroundColor: token.colorFillTertiary,
            }}
          />
        </div>

        {/* Model list */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0 12px' }}>
          {/* Pinned section */}
          {pinnedItems.length > 0 && (
            <div>
              <div
                className="flex items-center px-4 pt-3 pb-1"
                style={{ color: token.colorTextSecondary, fontSize: 13, fontWeight: 500 }}
              >
                <PinOff size={12} style={{ marginRight: 4 }} />
                <span>{t('chat.pinnedModels', '置顶模型')}</span>
              </div>
              {pinnedItems.map((item) =>
                renderModelRow(item.pid, item.mid, item.name, item.providerName, true, true),
              )}
              <div style={{ margin: '8px 16px 4px', borderTop: `1px solid ${token.colorBorderSecondary}` }} />
            </div>
          )}

          {/* Provider groups */}
          {filteredProviders.map((provider) => (
            <div key={provider.id}>
              <div
                className="flex items-center justify-between px-4 pt-3 pb-1"
                style={{ color: token.colorTextSecondary, fontSize: 13, fontWeight: 500 }}
              >
                <span>{provider.name}</span>
                <Settings
                  size={14}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setOpen(false);
                    setSearch('');
                    setActivePage('settings');
                    setSettingsSection('providers');
                    setSelectedProviderId(provider.id);
                  }}
                />
              </div>
              {provider.models.map((model) =>
                renderModelRow(provider.id, model.model_id, model.name, provider.name, pinnedModels.includes(`${provider.id}::${model.model_id}`), false),
              )}
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
}
