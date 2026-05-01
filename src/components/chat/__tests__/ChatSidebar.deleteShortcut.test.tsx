import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSidebar } from '../ChatSidebar';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  deleteConversation: vi.fn(),
  setActiveConversation: vi.fn(),
  createConversation: vi.fn(),
  updateConversation: vi.fn(),
  togglePin: vi.fn(),
  toggleArchive: vi.fn(),
  fetchArchivedConversations: vi.fn(),
  batchDelete: vi.fn(),
  batchArchive: vi.fn(),
  saveSettings: vi.fn(),
  fetchCategories: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  setCollapsed: vi.fn(),
}));

const conversationState = {
  conversations: [
    {
      id: 'conv-1',
      title: '快捷删除测试',
      provider_id: 'provider-1',
      model_id: 'model-1',
      category_id: null,
      parent_conversation_id: null,
      is_pinned: false,
      is_archived: false,
      message_count: 0,
      created_at: 1,
      updated_at: 1,
    },
  ],
  activeConversationId: 'conv-1',
  setActiveConversation: mocks.setActiveConversation,
  createConversation: mocks.createConversation,
  deleteConversation: mocks.deleteConversation,
  updateConversation: mocks.updateConversation,
  togglePin: mocks.togglePin,
  toggleArchive: mocks.toggleArchive,
  archivedConversations: [],
  fetchArchivedConversations: mocks.fetchArchivedConversations,
  batchDelete: mocks.batchDelete,
  batchArchive: mocks.batchArchive,
  streamingConversationId: null,
};

const providerState = {
  providers: [
    {
      id: 'provider-1',
      enabled: true,
      models: [
        {
          provider_id: 'provider-1',
          model_id: 'model-1',
          enabled: true,
          model_type: 'Chat',
        },
      ],
    },
  ],
};

const settingsState = {
  settings: {
    default_provider_id: 'provider-1',
    default_model_id: 'model-1',
    last_selected_conversation_id: null,
  },
  loading: false,
  saveSettings: mocks.saveSettings,
};

const categoryState = {
  categories: [],
  fetchCategories: mocks.fetchCategories,
  createCategory: mocks.createCategory,
  updateCategory: mocks.updateCategory,
  deleteCategory: mocks.deleteCategory,
  setCollapsed: mocks.setCollapsed,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'chat.delete': '删除',
      'chat.directDeleteHint': '按住 Ctrl 可直接删除',
      'chat.deleteConfirm': '确定删除此对话？',
      'chat.searchPlaceholder': '搜索对话...',
      'chat.archived': '已归档',
      'chat.createCategory': '新建分类',
      'chat.newConversation': '新建对话',
      'chat.multiSelect': '多选',
      'chat.noConversations': '暂无对话',
      'chat.today': '今天',
      'chat.yesterday': '昨天',
      'chat.thisWeek': '本周',
      'chat.thisMonth': '本月',
      'chat.earlier': '更早',
      'chat.pinned': '已置顶',
    }[key] ?? key),
  }),
}));

vi.mock('antd', () => ({
  App: {
    useApp: () => ({
      message: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
      modal: { confirm: mocks.confirm },
    }),
  },
  Button: ({ children, icon, onClick, 'aria-label': ariaLabel, title, disabled }: any) => (
    <button type="button" aria-label={ariaLabel ?? title} disabled={disabled} onClick={onClick}>
      {icon}
      {children}
    </button>
  ),
  Input: (props: any) => <input {...props} />,
  Tooltip: ({ children, title }: any) => (
    <span title={typeof title === 'string' ? title : undefined}>{children}</span>
  ),
  Checkbox: ({ checked, onChange, onClick }: any) => (
    <input type="checkbox" checked={checked} onChange={onChange} onClick={onClick} readOnly />
  ),
  Dropdown: ({ children }: any) => <>{children}</>,
  Empty: ({ description }: any) => <div>{description}</div>,
  Avatar: () => null,
  theme: {
    useToken: () => ({
      token: {
        colorPrimary: '#1677ff',
        colorPrimaryBg: '#e6f4ff',
        colorBgContainer: '#fff',
        colorFillContent: '#f5f5f5',
        colorTextSecondary: '#666',
        colorTextQuaternary: '#aaa',
      },
    }),
  },
}));

vi.mock('@ant-design/x/es/conversations', () => ({
  default: ({ items, menu }: any) => (
    <ul>
      {items.map((item: any) => {
        const menuConfig = typeof menu === 'function' ? menu(item) : menu;
        const trigger = menuConfig?.trigger
          ? menuConfig.trigger(item, { originNode: <button type="button" aria-label="更多" /> })
          : <button type="button" aria-label="更多" />;

        return (
          <li key={item.key} data-conv-id={item['data-conv-id']}>
            {item.icon}
            {item.label}
            {trigger}
            <button
              type="button"
              aria-label="菜单删除"
              onClick={() => menuConfig?.onClick?.({ key: 'delete', domEvent: {} })}
            />
          </li>
        );
      })}
    </ul>
  ),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: any) => <>{children}</>,
  DragOverlay: ({ children }: any) => <>{children}</>,
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
  useDroppable: () => ({
    setNodeRef: vi.fn(),
  }),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => null,
}));

vi.mock('@/stores', () => ({
  useConversationStore: Object.assign(
    (selector: (state: typeof conversationState) => unknown) => selector(conversationState),
    { getState: () => ({ ...conversationState, fetchConversations: vi.fn() }) },
  ),
  useProviderStore: (selector: (state: typeof providerState) => unknown) => selector(providerState),
  useSettingsStore: Object.assign(
    (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
    { getState: () => settingsState },
  ),
  useCategoryStore: Object.assign(
    (selector: (state: typeof categoryState) => unknown) => selector(categoryState),
    { setState: vi.fn(), getState: () => categoryState },
  ),
}));

vi.mock('@/hooks/useResolvedAvatarSrc', () => ({
  useResolvedAvatarSrc: () => null,
}));

vi.mock('@/lib/convIcon', () => ({
  getConvIcon: () => null,
}));

vi.mock('@/lib/exportChat', () => ({
  exportAsMarkdown: vi.fn(),
  exportAsText: vi.fn(),
  exportAsPNG: vi.fn(),
  exportAsJSON: vi.fn(),
}));

vi.mock('@/lib/invoke', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/lib/shortcuts', () => ({
  getShortcutBinding: () => 'CmdOrCtrl+N',
  formatShortcutForDisplay: () => 'Ctrl+N',
}));

vi.mock('../CategoryEditModal', () => ({
  CategoryEditModal: () => null,
}));

describe('ChatSidebar direct delete shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the confirmation dialog for a normal menu delete click', () => {
    render(<ChatSidebar />);

    expect(screen.getByRole('button', { name: '更多' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '菜单删除' }));

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.deleteConversation).not.toHaveBeenCalled();
  });

  it('turns the more trigger into direct delete while Ctrl is held', async () => {
    render(<ChatSidebar />);

    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '删除' }), { ctrlKey: true });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.deleteConversation).toHaveBeenCalledWith('conv-1');
  });

  it('turns the more trigger into direct delete while Cmd is held', async () => {
    render(<ChatSidebar />);

    fireEvent.keyDown(window, { key: 'Meta', metaKey: true });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '删除' }), { metaKey: true });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.deleteConversation).toHaveBeenCalledWith('conv-1');
  });

  it('does not add a separate row delete action and hides the delete trigger on active rows until hover', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/chat/ChatSidebar.tsx'),
      'utf8',
    );

    expect(source).not.toContain('aqbot-chat-conversation-direct-delete');
    expect(source).toContain('.ant-conversations .ant-conversations-item-active .aqbot-chat-conversation-menu-delete');
    expect(source).toContain('opacity: 0;');
  });
});
