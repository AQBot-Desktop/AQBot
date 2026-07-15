import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RolesPage } from '../RolesPage';
import type { MarketplaceRole, Role, RoleMarketplaceSource } from '@/types';

const mocks = vi.hoisted(() => ({
  ensureRolesLoaded: vi.fn(),
  ensureMarketplaceSourcesLoaded: vi.fn(),
  loadRoles: vi.fn(),
  searchMarketplace: vi.fn(),
  installRole: vi.fn(),
  createRole: vi.fn(),
  updateRole: vi.fn(),
  deleteRole: vi.fn(),
  loadMarketplaceSources: vi.fn(),
  setMarketplaceSource: vi.fn(),
  updateConversation: vi.fn(),
  createConversation: vi.fn(),
  setActiveConversation: vi.fn(),
  setActivePage: vi.fn(),
}));

const roles: Role[] = [
  {
    id: 'role-1',
    name: '中文翻译助手',
    description: '把用户输入翻译成中文',
    system_prompt: '你是中文翻译助手',
    opening_message: '发来文本',
    opening_questions: ['翻译这段话'],
    tags: ['翻译'],
    avatar: '🌐',
    avatar_type: 'emoji',
    avatar_value: '🌐',
    temperature: 0.2,
    top_p: 0.8,
    source_kind: 'local',
    source_ref: null,
    created_at: 1,
    updated_at: 1,
  },
];

const marketplaceRoles: MarketplaceRole[] = [
  {
    id: 'market-role',
    name: 'English Translator',
    description: 'Translate text',
    tags: ['text'],
    avatar: '💬',
    avatar_type: 'emoji',
    avatar_value: '💬',
    temperature: null,
    top_p: null,
    source_kind: 'prompts-chat',
    source_ref: 'prompts-chat://english-translator',
    marketplace_source: 'prompts-chat',
    installed: false,
  },
];

const marketplaceSources: RoleMarketplaceSource[] = [
  { id: 'prompts-chat', name: 'prompts.chat', default: true },
  { id: 'plexpt-zh', name: 'PlexPt 中文', default: false },
];

const storeState = vi.hoisted(() => ({
  roles: [] as Role[],
  marketplaceRoles: [] as MarketplaceRole[],
  activeConversationId: 'conv-1' as string | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'roles.title': '角色',
        'roles.myRoles': '我的角色',
        'roles.marketplace': '市场',
        'roles.applyToCurrent': '应用到当前会话',
        'roles.newConversation': '新建会话并使用',
        'roles.use': '使用',
        'roles.moreActions': '更多角色操作',
        'roles.install': '安装',
        'roles.searchPlaceholder': '搜索角色',
        'roles.empty': '暂无角色',
        'roles.emptyDesc': '还没有角色',
        'roles.marketplaceEmpty': '暂无市场角色',
        'roles.create': '新建角色',
        'roles.name': '角色名称',
        'roles.avatar': '头像',
        'roles.description': '描述',
        'roles.systemPrompt': '系统提示词',
        'roles.openingMessage': '开场白',
        'roles.openingQuestions': '开场问题',
        'roles.tags': '标签',
        'roles.modelParams': '模型参数',
        'roles.edit': '编辑',
        'roles.delete': '删除',
        'roles.deleteConfirm': '删除角色？',
        'common.cancel': '取消',
        'common.save': '保存',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('@/components/shared/IconEditor', () => ({
  IconEditor: ({ onChange }: { onChange: (type: string | null, value: string | null) => void }) => (
    <button type="button" onClick={() => onChange('emoji', '😀')}>avatar-editor</button>
  ),
}));

vi.mock('@/components/common/ModelParamSliders', () => ({
  ModelParamSliders: () => <div>model-param-sliders</div>,
}));

vi.mock('@/hooks/useResolvedAvatarSrc', () => ({
  useResolvedAvatarSrc: () => null,
}));

vi.mock('@/stores', () => ({
  useRoleStore: () => ({
    roles: storeState.roles,
    marketplaceRoles: storeState.marketplaceRoles,
    marketplaceSources,
    selectedMarketplaceSource: 'prompts-chat',
    loading: false,
    marketplaceLoading: false,
    ensureRolesLoaded: mocks.ensureRolesLoaded,
    ensureMarketplaceSourcesLoaded: mocks.ensureMarketplaceSourcesLoaded,
    loadRoles: mocks.loadRoles,
    loadMarketplaceSources: mocks.loadMarketplaceSources,
    setMarketplaceSource: mocks.setMarketplaceSource,
    createRole: mocks.createRole,
    updateRole: mocks.updateRole,
    deleteRole: mocks.deleteRole,
    searchMarketplace: mocks.searchMarketplace,
    installRole: mocks.installRole,
  }),
  useConversationStore: (selector?: (state: any) => unknown) => {
    const state = {
    activeConversationId: storeState.activeConversationId,
    conversations: [{ id: 'conv-1', provider_id: 'provider-1', model_id: 'model-1', system_prompt: null }],
    updateConversation: mocks.updateConversation,
    createConversation: mocks.createConversation,
    setActiveConversation: mocks.setActiveConversation,
    };
    return selector ? selector(state) : state;
  },
  useUIStore: (selector?: (state: any) => unknown) => {
    const state = { setActivePage: mocks.setActivePage };
    return selector ? selector(state) : state;
  },
  useProviderStore: (selector?: (state: any) => unknown) => {
    const state = {
    providers: [
      {
        id: 'provider-1',
        enabled: true,
        models: [{ model_id: 'model-1', enabled: true }],
      },
    ],
    };
    return selector ? selector(state) : state;
  },
  useSettingsStore: (selector?: (state: any) => unknown) => {
    const state = {
    settings: {
      default_provider_id: 'provider-1',
      default_model_id: 'model-1',
    },
    };
    return selector ? selector(state) : state;
  },
}));

describe('RolesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.createConversation.mockResolvedValue({ id: 'conv-2' });
    storeState.roles = roles;
    storeState.marketplaceRoles = marketplaceRoles;
    storeState.activeConversationId = 'conv-1';
  });

  it('creates a new role conversation from the main use button', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);

    expect(screen.getByText('中文翻译助手')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => {
      expect(mocks.createConversation).toHaveBeenCalledWith('中文翻译助手', 'model-1', 'provider-1');
    });
    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-2', {
      system_prompt: '你是中文翻译助手',
      temperature: 0.2,
      top_p: 0.8,
      mode: 'role',
    });
    expect(localStorage.getItem('aqbot_conv_icon_conv-2')).toBe(JSON.stringify({ type: 'emoji', value: '🌐' }));
    expect(JSON.parse(localStorage.getItem('aqbot_role_intro_conv-2') ?? '{}')).toEqual({
      openingMessage: '发来文本',
      openingQuestions: ['翻译这段话'],
    });
    expect(mocks.setActiveConversation).toHaveBeenCalledWith('conv-2');
    expect(mocks.setActivePage).toHaveBeenCalledWith('chat');
  });

  it('applies a role to the active conversation from the dropdown item', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);

    await user.click(screen.getByRole('button', { name: '更多角色操作' }));
    expect(screen.queryByText('新建会话并使用')).not.toBeInTheDocument();
    await user.click(screen.getByText('应用到当前会话'));

    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', {
      system_prompt: '你是中文翻译助手',
      temperature: 0.2,
      top_p: 0.8,
      mode: 'role',
    });
    expect(localStorage.getItem('aqbot_conv_icon_conv-1')).toBe(JSON.stringify({ type: 'emoji', value: '🌐' }));
    expect(mocks.setActiveConversation).not.toHaveBeenCalled();
    expect(mocks.setActivePage).toHaveBeenCalledWith('chat');
  });

  it('opens marketplace on first visit when no local roles exist', async () => {
    storeState.roles = [];

    render(<RolesPage />);

    expect(await screen.findByRole('tab', { name: '市场', selected: true })).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.searchMarketplace).toHaveBeenCalledWith('');
    });
  });

  it('loads marketplace sources and searches after changing source', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);

    await user.click(screen.getByRole('tab', { name: '市场' }));
    expect(mocks.ensureMarketplaceSourcesLoaded).toHaveBeenCalled();
    expect(mocks.searchMarketplace).toHaveBeenCalledWith('');

    await user.click(screen.getByRole('combobox'));
    expect(screen.queryByText('AQBot')).not.toBeInTheDocument();
    expect(screen.queryByText('LobeHub')).not.toBeInTheDocument();
    await user.click(screen.getByText('PlexPt 中文'));

    expect(mocks.setMarketplaceSource).toHaveBeenCalledWith('plexpt-zh');
    expect(mocks.searchMarketplace).toHaveBeenCalledWith('');
  });

  it('installs a marketplace role', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);

    await user.click(screen.getByRole('tab', { name: '市场' }));
    await user.click(screen.getByRole('button', { name: '安装' }));

    expect(mocks.installRole).toHaveBeenCalledWith('prompts-chat', 'prompts-chat://english-translator');
  });

  it('keeps role result lists scrollable inside their tabs', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);

    expect(screen.getByTestId('roles-tabs-shell')).toHaveStyle({
      display: 'flex',
      flexDirection: 'column',
    });
    expect(screen.getByTestId('roles-list-scroll')).toHaveStyle({
      overflowY: 'auto',
    });

    await user.click(screen.getByRole('tab', { name: '市场' }));

    expect(screen.getByTestId('roles-marketplace-list-scroll')).toHaveStyle({
      overflowY: 'auto',
    });
  });

  it('renders the role editor as a vertical form', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);

    await user.click(screen.getByRole('button', { name: '新建角色' }));

    expect(screen.getByText('头像')).toBeInTheDocument();
    expect(screen.getByText('角色名称')).toBeInTheDocument();
    expect(screen.getByText('标签')).toBeInTheDocument();
    expect(screen.getByText('开场问题')).toBeInTheDocument();
    expect(screen.getByText('模型参数')).toBeInTheDocument();
  });
});
