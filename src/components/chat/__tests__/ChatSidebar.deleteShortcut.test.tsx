import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  regenerateTitle: vi.fn(),
  saveSettings: vi.fn(),
  ensureCategoriesLoaded: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  setCollapsed: vi.fn(),
}));

const conversationState: any = {
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
  titleGeneratingConversationId: null,
  regenerateTitle: mocks.regenerateTitle,
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

const categoryState: any = {
  categories: [],
  ensureCategoriesLoaded: mocks.ensureCategoriesLoaded,
  createCategory: mocks.createCategory,
  updateCategory: mocks.updateCategory,
  deleteCategory: mocks.deleteCategory,
  setCollapsed: mocks.setCollapsed,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => ({
      'chat.delete': '删除',
      'chat.directDeleteHint': '按住 Ctrl 可直接删除',
      'chat.deleteConfirm': '确定删除此对话？',
      'chat.searchPlaceholder': '搜索对话...',
      'chat.archived': '已归档',
      'chat.createCategory': '新建分类',
      'chat.newConversation': '新建对话',
      'chat.newConversationInCurrentCategory': `在 ${options?.category ?? '当前分类'} 下新建`,
      'chat.newStandaloneConversation': '独立新建',
      'chat.multiSelect': '多选',
      'chat.noConversations': '暂无对话',
      'chat.today': '今天',
      'chat.yesterday': '昨天',
      'chat.thisWeek': '本周',
      'chat.thisMonth': '本月',
      'chat.earlier': '更早',
      'chat.pin': '置顶',
      'chat.unpin': '取消置顶',
      'chat.pinned': '已置顶',
      'chat.archive': '归档',
      'chat.rename': '重命名',
      'chat.generateTitle': '生成标题',
      'chat.generatingTitle': '正在生成标题',
      'chat.export': '导出',
      'common.agentMode': 'Agent',
      'nav.roles': 'Role Label',
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
  Tooltip: ({ children, title, ...triggerProps }: any) => (
    <span {...triggerProps} title={typeof title === 'string' ? title : undefined}>{children}</span>
  ),
  Checkbox: ({ checked, onChange, onClick }: any) => (
    <input type="checkbox" checked={checked} onChange={onChange} onClick={onClick} readOnly />
  ),
  Dropdown: ({ children, menu }: any) => (
    <div>
      {children}
      {menu?.items?.map((item: any) => (
        <button
          key={item.key}
          type="button"
          aria-label={typeof item.label === 'string' ? item.label : undefined}
          disabled={item.disabled}
          onClick={() => menu.onClick?.({ key: item.key, domEvent: { stopPropagation: vi.fn() } })}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  ),
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
  default: ({ items, menu, activeKey, onActiveChange }: any) => (
    <ul>
      {items.map((item: any) => {
        const menuConfig = typeof menu === 'function' ? menu(item) : menu;
        const originNode = <button type="button" aria-label="更多" />;
        const trigger = typeof menuConfig?.trigger === 'function'
          ? menuConfig.trigger(item, { originNode })
          : menuConfig?.trigger ?? originNode;

        return (
          <li
            key={item.key}
            data-conv-id={item['data-conv-id']}
            className={activeKey === item.key ? 'ant-conversations-item-active' : undefined}
            onClick={() => onActiveChange?.(item.key, item)}
          >
            {item.icon}
            {item.label}
            {menuConfig && trigger}
            {menuConfig?.items?.map((menuItem: any) => (
              <button
                key={menuItem.key}
                type="button"
                aria-label={typeof menuItem.label === 'string' ? `菜单${menuItem.label}` : undefined}
                disabled={menuItem.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  menuConfig.onClick?.({ key: menuItem.key, domEvent: event });
                }}
              >
                {menuItem.icon}
                {menuItem.label}
              </button>
            ))}
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
  modelMappings: [],
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

function armConversationMenu(title = '快捷删除测试') {
  const row = screen.getByText(title).closest('li');
  expect(row).not.toBeNull();
  fireEvent.pointerOver(row!);
}

describe('ChatSidebar direct delete shortcut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationState.conversations = [
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
    ];
    conversationState.activeConversationId = 'conv-1';
    conversationState.titleGeneratingConversationId = null;
    categoryState.categories = [];
    mocks.ensureCategoriesLoaded.mockResolvedValue(undefined);
    mocks.regenerateTitle.mockResolvedValue(undefined);
    mocks.createConversation.mockResolvedValue({
      id: 'conv-new',
      title: '新建对话',
      provider_id: 'provider-1',
      model_id: 'model-1',
      category_id: null,
      parent_conversation_id: null,
      is_pinned: false,
      is_archived: false,
      message_count: 0,
      created_at: 2,
      updated_at: 2,
    });
  });

  it('keeps the confirmation dialog for a normal menu delete click', async () => {
    render(<ChatSidebar />);

    expect(screen.queryByRole('button', { name: '更多' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '菜单删除' })).not.toBeInTheDocument();

    armConversationMenu();

    expect(screen.getByRole('button', { name: '更多' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    const deleteButton = await screen.findByRole('button', { name: '菜单删除' });
    fireEvent.click(deleteButton);

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.deleteConversation).not.toHaveBeenCalled();
  });

  it('renders long conversation titles inside a constrained truncation element', () => {
    const longTitle = '这是一个非常长的用户首条消息标题，用来模拟标题总结模型失败时回退到用户输入导致侧边栏被撑高的问题';
    conversationState.conversations[0].title = longTitle;

    render(<ChatSidebar />);

    const title = screen.getByText(longTitle);
    expect(title).toHaveClass('aqbot-chat-conversation-title');
    expect(title).toHaveAttribute('title', longTitle);
    expect(title).toHaveStyle({
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
  });

  it('uses i18n for the role badge on role conversations', () => {
    conversationState.conversations[0].mode = 'role';

    render(<ChatSidebar />);

    expect(screen.getByText('Role Label')).toBeInTheDocument();
  });

  it('keeps the agent badge on agent conversations', () => {
    conversationState.conversations[0].mode = 'agent';

    render(<ChatSidebar />);

    expect(screen.getByText('Agent')).toBeInTheDocument();
  });

  it('switches the active conversation through the rendered row', () => {
    conversationState.conversations = [
      { ...conversationState.conversations[0], id: 'conv-1', title: '第一条', updated_at: 2 },
      { ...conversationState.conversations[0], id: 'conv-2', title: '第二条', updated_at: 1 },
    ];

    render(<ChatSidebar />);
    fireEvent.click(screen.getByText('第二条'));

    expect(mocks.setActiveConversation).toHaveBeenCalledWith('conv-2');
  });

  it('filters rendered conversation rows by title', () => {
    conversationState.conversations = [
      { ...conversationState.conversations[0], id: 'conv-1', title: 'Alpha 规划', updated_at: 2 },
      { ...conversationState.conversations[0], id: 'conv-2', title: 'Beta 记录', updated_at: 1 },
    ];

    render(<ChatSidebar />);
    fireEvent.click(within(screen.getByTitle('搜索对话...')).getByRole('button'));
    fireEvent.change(screen.getByPlaceholderText('搜索对话...'), { target: { value: 'beta' } });

    expect(screen.queryByText('Alpha 规划')).not.toBeInTheDocument();
    expect(screen.getByText('Beta 记录')).toBeInTheDocument();
  });

  it('reveals a child conversation only after its parent toggle is clicked', () => {
    conversationState.conversations = [
      { ...conversationState.conversations[0], id: 'parent', title: '父对话', updated_at: 2 },
      {
        ...conversationState.conversations[0],
        id: 'child',
        title: '子对话',
        parent_conversation_id: 'parent',
        updated_at: 1,
      },
    ];
    conversationState.activeConversationId = 'parent';

    render(<ChatSidebar />);
    expect(screen.queryByText('子对话')).not.toBeInTheDocument();

    const toggle = screen.getByText('父对话').closest('li')?.querySelector('.lucide-chevron-right');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);

    expect(screen.getByText('子对话')).toBeInTheDocument();
  });

  it('turns the more trigger into direct delete while Ctrl is held', async () => {
    render(<ChatSidebar />);
    armConversationMenu();

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
    armConversationMenu();

    fireEvent.keyDown(window, { key: 'Meta', metaKey: true });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '删除' }), { metaKey: true });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.deleteConversation).toHaveBeenCalledWith('conv-1');
  });

  it('keeps a single menu trigger and only exposes direct delete while the shortcut is held', async () => {
    render(<ChatSidebar />);
    armConversationMenu();

    expect(screen.getAllByRole('button', { name: '更多' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1);
    });
  });

  it('offers current-category and standalone choices when creating from a categorized conversation', async () => {
    conversationState.conversations[0].category_id = 'cat-work';
    categoryState.categories = [
      {
        id: 'cat-work',
        name: '工作',
        icon_type: null,
        icon_value: null,
        system_prompt: '工作分类提示词',
        default_provider_id: null,
        default_model_id: null,
        default_temperature: null,
        default_max_tokens: null,
        default_top_p: null,
        default_frequency_penalty: null,
        sort_order: 0,
        is_collapsed: false,
        created_at: 1,
        updated_at: 1,
      },
    ];

    render(<ChatSidebar />);

    fireEvent.click(screen.getByRole('button', { name: '在 工作 下新建' }));

    await waitFor(() => {
      expect(mocks.createConversation).toHaveBeenCalledWith(
        '新建对话',
        'model-1',
        'provider-1',
        { categoryId: 'cat-work' },
      );
    });
    expect(mocks.setActiveConversation).not.toHaveBeenCalled();
  });

  it('lets users create a standalone conversation from a categorized conversation', async () => {
    conversationState.conversations[0].category_id = 'cat-work';
    categoryState.categories = [
      {
        id: 'cat-work',
        name: '工作',
        icon_type: null,
        icon_value: null,
        system_prompt: '工作分类提示词',
        default_provider_id: null,
        default_model_id: null,
        default_temperature: null,
        default_max_tokens: null,
        default_top_p: null,
        default_frequency_penalty: null,
        sort_order: 0,
        is_collapsed: false,
        created_at: 1,
        updated_at: 1,
      },
    ];

    render(<ChatSidebar />);

    fireEvent.click(screen.getByRole('button', { name: '独立新建' }));

    await waitFor(() => {
      expect(mocks.createConversation).toHaveBeenCalledWith(
        '新建对话',
        'model-1',
        'provider-1',
        { categoryId: null },
      );
    });
  });

  it('wraps long sidebar conversation titles in a truncation target with the full title available', () => {
    const longTitle = '这是一个非常长的会话标题，用于验证侧边栏不会因为标题过长而撑高或者挤压操作按钮';
    conversationState.conversations[0].title = longTitle;

    render(<ChatSidebar />);

    const title = screen.getByText(longTitle);
    expect(title).toHaveClass('aqbot-chat-conversation-title');
    expect(title).toHaveAttribute('title', longTitle);
  });

  it('shows an inline loading status on the conversation row while generating its title', () => {
    conversationState.titleGeneratingConversationId = 'conv-1';

    render(<ChatSidebar />);

    const status = screen.getByRole('status', { name: '正在生成标题' });
    expect(status).toHaveClass('aqbot-chat-conversation-title-generating');
  });

  it('keeps long title truncation separate from the title generation loading indicator', () => {
    const longTitle = '这是一个非常长的会话标题，用于验证侧边栏不会因为标题过长而撑高或者挤压操作按钮';
    conversationState.conversations[0].title = longTitle;
    conversationState.titleGeneratingConversationId = 'conv-1';

    render(<ChatSidebar />);

    const title = screen.getByText(longTitle);
    expect(title).toHaveClass('aqbot-chat-conversation-title');
    expect(title).toHaveAttribute('title', longTitle);
    expect(title).not.toHaveTextContent('正在生成标题');
    expect(screen.getByRole('status', { name: '正在生成标题' })).toBeInTheDocument();
  });

  it('adds generate title after rename in the right-click menu and calls the title regeneration action', async () => {
    render(<ChatSidebar />);

    fireEvent.contextMenu(screen.getByText('快捷删除测试'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '生成标题' })).toBeInTheDocument();
    });

    const menuLabels = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent)
      .filter(Boolean);
    expect(menuLabels.indexOf('生成标题')).toBeGreaterThan(menuLabels.indexOf('重命名'));
    expect(menuLabels.indexOf('生成标题')).toBeLessThan(menuLabels.indexOf('导出'));

    fireEvent.click(screen.getByRole('button', { name: '生成标题' }));

    expect(mocks.regenerateTitle).toHaveBeenCalledWith('conv-1');
  });

  it('disables generate title while the conversation title is already generating', async () => {
    conversationState.titleGeneratingConversationId = 'conv-1';

    render(<ChatSidebar />);

    fireEvent.contextMenu(screen.getByText('快捷删除测试'));

    const generateTitleButton = await screen.findByRole('button', { name: '生成标题' });
    expect(generateTitleButton).toBeDisabled();

    fireEvent.click(generateTitleButton);

    expect(mocks.regenerateTitle).not.toHaveBeenCalled();
  });

});
