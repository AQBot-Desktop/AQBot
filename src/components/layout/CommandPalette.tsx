import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Modal, Input, List, Tag, Typography, theme } from 'antd';
import { Search, MessageSquare, Settings, Network, Plus, PanelLeftClose, Sparkles, ImagePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '@/stores';
import { formatShortcutForDisplay } from '@/lib/shortcuts';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface Command {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  category: string;
  action: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const setActivePage = useUIStore((s) => s.setActivePage);
  const setSettingsSection = useUIStore((s) => s.setSettingsSection);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const commands = useMemo<Command[]>(() => {
    const nav = t('commandPalette.navigation');
    const actions = t('commandPalette.actions');
    const settings = t('commandPalette.settings');
    const openSettingsShortcut = formatShortcutForDisplay('CmdOrCtrl+,');
    const newConversationShortcut = formatShortcutForDisplay('CmdOrCtrl+N');
    const searchConversationsShortcut = formatShortcutForDisplay('CmdOrCtrl+F');

    return [
      {
        id: 'go-chat',
        label: t('commandPalette.goToChat'),
        icon: <MessageSquare size={16} />,
        category: nav,
        action: () => { setActivePage('chat'); onClose(); },
      },
      {
        id: 'go-settings',
        label: t('commandPalette.goToSettings'),
        icon: <Settings size={16} />,
        shortcut: openSettingsShortcut,
        category: nav,
        action: () => { setActivePage('settings'); onClose(); },
      },
      {
        id: 'go-drawing',
        label: t('commandPalette.goToDrawing'),
        icon: <ImagePlus size={16} />,
        category: nav,
        action: () => { setActivePage('drawing'); onClose(); },
      },
      {
        id: 'go-gateway',
        label: t('commandPalette.goToGateway'),
        icon: <Network size={16} />,
        category: nav,
        action: () => { setActivePage('gateway'); onClose(); },
      },
      {
        id: 'go-skills',
        label: t('commandPalette.goToSkills'),
        icon: <Sparkles size={16} />,
        category: nav,
        action: () => { setActivePage('skills'); onClose(); },
      },
      {
        id: 'new-conversation',
        label: t('commandPalette.newConversation'),
        icon: <Plus size={16} />,
        shortcut: newConversationShortcut,
        category: actions,
        action: () => { setActivePage('chat'); onClose(); },
      },
      {
        id: 'toggle-sidebar',
        label: t('commandPalette.toggleSidebar'),
        icon: <PanelLeftClose size={16} />,
        category: actions,
        action: () => { toggleSidebar(); onClose(); },
      },
      {
        id: 'search-conversations',
        label: t('commandPalette.searchConversations'),
        icon: <Search size={16} />,
        shortcut: searchConversationsShortcut,
        category: actions,
        action: () => { setActivePage('chat'); onClose(); },
      },
      {
        id: 'settings-search',
        label: `${t('commandPalette.goToSettings')} → ${t('settings.searchProviders.title')}`,
        icon: <Settings size={16} />,
        category: settings,
        action: () => { setActivePage('settings'); setSettingsSection('searchProviders'); onClose(); },
      },
      {
        id: 'settings-mcp',
        label: `${t('commandPalette.goToSettings')} → ${t('settings.mcpServers.title')}`,
        icon: <Settings size={16} />,
        category: settings,
        action: () => { setActivePage('settings'); setSettingsSection('mcpServers'); onClose(); },
      },
    ];
  }, [t, setActivePage, setSettingsSection, toggleSidebar, onClose]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter' && filtered.length > 0) {
        e.preventDefault();
        filtered[activeIndex]?.action();
      }
    },
    [filtered, activeIndex],
  );

  // Group commands by category for display
  const grouped = useMemo(() => {
    const groups: Record<string, Command[]> = {};
    for (const cmd of filtered) {
      if (!groups[cmd.category]) groups[cmd.category] = [];
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filtered]);

  let flatIndex = 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      mask={{ enabled: true, blur: true }}
      footer={null}
      closable={false}
      centered
      width={600}
      styles={{ body: { padding: 0 } }}
    >
      <div onKeyDown={handleKeyDown}>
        <Input
          prefix={<Search size={16} />}
          placeholder={t('commandPalette.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          variant="borderless"
          size="large"
          autoFocus
          style={{ padding: '12px 16px' }}
        />
        <div
          ref={listRef}
          data-os-scrollbar
          style={{
            maxHeight: 400,
            overflowY: 'auto',
            borderTop: '1px solid var(--border-color)',
          }}
        >
          {Object.entries(grouped).map(([category, cmds]) => (
            <div key={category}>
              <Typography.Text
                type="secondary"
                style={{
                  display: 'block',
                  padding: '8px 16px 4px',
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                {category}
              </Typography.Text>
              <List
                dataSource={cmds}
                renderItem={(cmd) => {
                  const idx = flatIndex++;
                  const isActive = idx === activeIndex;
                  return (
                    <List.Item
                      key={cmd.id}
                      onClick={cmd.action}
                      style={{
                        cursor: 'pointer',
                        padding: '8px 16px',
                        backgroundColor: isActive ? token.colorBgTextHover : undefined,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          width: '100%',
                          gap: 8,
                        }}
                      >
                        <span style={{ fontSize: 16 }}>{cmd.icon}</span>
                        <span style={{ flex: 1 }}>{cmd.label}</span>
                        {cmd.shortcut && (
                          <Tag style={{ margin: 0 }}>{cmd.shortcut}</Tag>
                        )}
                      </div>
                    </List.Item>
                  );
                }}
              />
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <Typography.Text type="secondary">{t('common.noData')}</Typography.Text>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
