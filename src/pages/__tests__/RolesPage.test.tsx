import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  ensureSkillsLoaded: vi.fn(),
  toggleSkill: vi.fn(),
  ensureBasesLoaded: vi.fn(),
  ensureNamespacesLoaded: vi.fn(),
}));

const roles: Role[] = [
  {
    id: 'role-1',
    name: '中文翻译助手',
    description: '把用户输入翻译成中文',
    system_prompt: '你是中文翻译助手',
    opening_message: '发来文本',
    opening_questions: [{ title: null, content: '翻译这段话' }],
    tags: ['翻译'],
    avatar: '🌐',
    avatar_type: 'emoji',
    avatar_value: '🌐',
    temperature: 0.2,
    top_p: 0.8,
    enabled_mcp_server_ids: [],
    enabled_skill_names: [],
    enabled_knowledge_base_ids: [],
    enabled_memory_namespace_ids: [],
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
  conversations: [
    { id: 'conv-1', provider_id: 'provider-1', model_id: 'model-1', system_prompt: null as string | null, mode: undefined as 'chat' | 'agent' | 'role' | undefined },
  ],
  archivedConversations: [] as Array<{
    id: string;
    provider_id: string;
    model_id: string;
    system_prompt: string | null;
    mode: 'chat' | 'agent' | 'role' | undefined;
  }>,
  skills: [] as Array<{ name: string; enabled: boolean }>,
  bases: [] as Array<{ id: string; name: string; enabled: boolean; sortOrder: number }>,
  namespaces: [] as Array<{ id: string; name: string; scope: 'global'; sortOrder: number }>,
  basesMeta: { status: 'ready' as const, key: 'knowledge-bases', loadedAt: 1, revision: 1 },
  namespacesMeta: { status: 'ready' as const, key: 'memory-namespaces', loadedAt: 1, revision: 1 },
}));

function roleApplyPayload(overrides: Record<string, unknown> = {}) {
  return {
    system_prompt: '你是中文翻译助手',
    temperature: 0.2,
    top_p: 0.8,
    mode: 'role',
    enabled_knowledge_base_ids: [],
    enabled_memory_namespace_ids: [],
    ...overrides,
  };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
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
        'roles.openingQuestionPlaceholder': '输入一个开场问题',
        'roles.openingQuestionTitle': '标题',
        'roles.openingQuestionTitlePlaceholder': '可选短标题',
        'roles.addOpeningQuestion': '添加问题',
        'roles.removeOpeningQuestion': '删除问题',
        'roles.namePlaceholder': '请输入角色名称',
        'roles.systemPromptPlaceholder': '定义角色的系统提示词（必填）',
        'roles.tags': '标签',
        'roles.modelParams': '模型参数',
        'roles.capabilities': '能力绑定',
        'roles.mcpServers': 'MCP 服务器',
        'roles.mcpServersHint': 'MCP 提示',
        'roles.mcpServersPlaceholder': '搜索并选择 MCP 服务器',
        'roles.mcpEmpty': '暂无已启用的 MCP 服务器',
        'roles.skills': '技能',
        'roles.skillsHint': '技能提示',
        'roles.skillsPlaceholder': '搜索并选择技能',
        'roles.skillsEmpty': '暂无已安装技能',
        'roles.knowledgeBases': '知识库',
        'roles.knowledgeBasesHint': '知识库提示',
        'roles.knowledgeBasesPlaceholder': '搜索并选择知识库',
        'roles.knowledgeEmpty': '暂无知识库',
        'roles.knowledgeLoadFailed': '无法加载知识库，请稍后重试',
        'roles.memoryNamespaces': '记忆空间',
        'roles.memoryNamespacesHint': '记忆空间提示',
        'roles.memoryNamespacesPlaceholder': '搜索并选择记忆空间',
        'roles.memoryEmpty': '暂无记忆空间',
        'roles.memoryLoadFailed': '无法加载记忆空间，请稍后重试',
        'roles.contextBindingsHint': '应用角色将替换会话的知识库和记忆选择，之后可在会话中单独调整',
        'roles.missingBindings': '以下绑定已失效，请移除后再保存：{{items}}',
        'roles.applyCreatedButFailed': '会话已创建，角色配置未应用',
        'roles.validation.nameRequired': '请输入角色名称',
        'roles.validation.systemPromptRequired': '请输入系统提示词',
        'roles.validation.openingQuestionContentRequired': '请填写开场问题正文',
        'roles.validation.contextBindingsMissing': '角色绑定的知识库或记忆空间已不存在',
        'roles.validation.contextBindingsLoadFailed': '无法加载知识库或记忆空间，请稍后重试',
        'roles.saveSuccess': '角色已保存',
        'roles.applyFailed': '应用角色失败',
        'roles.conversationMissing': '当前会话不存在，无法应用角色',
        'roles.applied': '已应用到当前会话',
        'roles.edit': '编辑',
        'roles.delete': '删除',
        'roles.deleteConfirm': '删除角色？',
        'common.cancel': '取消',
        'common.save': '保存',
      };
      let text = translations[key] ?? key;
      if (opts) {
        for (const [name, value] of Object.entries(opts)) {
          text = text.replaceAll(`{{${name}}}`, String(value));
        }
      }
      return text;
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

vi.mock('@/components/shared/McpServerIcon', () => ({
  McpServerIcon: () => <span>mcp-icon</span>,
}));

vi.mock('@/components/shared/KnowledgeBaseIcon', () => ({
  KnowledgeBaseIcon: () => <span>kb-icon</span>,
}));

vi.mock('@/components/shared/NamespaceIcon', () => ({
  NamespaceIcon: () => <span>ns-icon</span>,
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
    conversations: storeState.conversations,
    archivedConversations: storeState.archivedConversations,
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
  useMcpStore: (selector?: (state: any) => unknown) => {
    const state = {
      servers: [],
      ensureServersLoaded: vi.fn().mockResolvedValue(undefined),
    };
    return selector ? selector(state) : state;
  },
  useSkillStore: Object.assign(
    (selector?: (state: any) => unknown) => {
      const state = {
        skills: storeState.skills,
        ensureSkillsLoaded: mocks.ensureSkillsLoaded,
        toggleSkill: mocks.toggleSkill,
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({ skills: storeState.skills }),
    },
  ),
  useKnowledgeStore: Object.assign(
    (selector?: (state: any) => unknown) => {
      const state = {
        bases: storeState.bases,
        basesMeta: storeState.basesMeta,
        ensureBasesLoaded: mocks.ensureBasesLoaded,
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        bases: storeState.bases,
        basesMeta: storeState.basesMeta,
        ensureBasesLoaded: mocks.ensureBasesLoaded,
      }),
    },
  ),
  useMemoryStore: Object.assign(
    (selector?: (state: any) => unknown) => {
      const state = {
        namespaces: storeState.namespaces,
        namespacesMeta: storeState.namespacesMeta,
        ensureNamespacesLoaded: mocks.ensureNamespacesLoaded,
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        namespaces: storeState.namespaces,
        namespacesMeta: storeState.namespacesMeta,
        ensureNamespacesLoaded: mocks.ensureNamespacesLoaded,
      }),
    },
  ),
}));

describe('RolesPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    mocks.createConversation.mockResolvedValue({ id: 'conv-2' });
    mocks.ensureSkillsLoaded.mockResolvedValue(undefined);
    mocks.toggleSkill.mockResolvedValue(undefined);
    mocks.ensureBasesLoaded.mockResolvedValue(undefined);
    mocks.ensureNamespacesLoaded.mockResolvedValue(undefined);
    storeState.roles = roles;
    storeState.bases = [];
    storeState.namespaces = [];
    storeState.basesMeta = { status: 'ready', key: 'knowledge-bases', loadedAt: 1, revision: 1 };
    storeState.namespacesMeta = { status: 'ready', key: 'memory-namespaces', loadedAt: 1, revision: 1 };
    storeState.marketplaceRoles = marketplaceRoles;
    storeState.activeConversationId = 'conv-1';
    storeState.conversations = [
      { id: 'conv-1', provider_id: 'provider-1', model_id: 'model-1', system_prompt: null, mode: undefined },
    ];
    storeState.archivedConversations = [];
    storeState.skills = [];
  });

  it('creates a new role conversation from the main use button', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);

    expect(screen.getByText('中文翻译助手')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => {
      expect(mocks.createConversation).toHaveBeenCalledWith('中文翻译助手', 'model-1', 'provider-1');
    });
    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-2', roleApplyPayload());
    expect(localStorage.getItem('aqbot_conv_icon_conv-2')).toBe(JSON.stringify({ type: 'emoji', value: '🌐' }));
    expect(JSON.parse(localStorage.getItem('aqbot_role_intro_conv-2') ?? '{}')).toEqual({
      openingMessage: '发来文本',
      openingQuestions: ['翻译这段话'],
      openingQuestionItems: [{ title: null, content: '翻译这段话' }],
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
    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', roleApplyPayload());
    expect(localStorage.getItem('aqbot_conv_icon_conv-1')).toBe(JSON.stringify({ type: 'emoji', value: '🌐' }));
    expect(mocks.setActiveConversation).not.toHaveBeenCalled();
    expect(mocks.setActivePage).toHaveBeenCalledWith('chat');
  });

  it('keeps Agent mode when applying a role to the active Agent conversation', async () => {
    const user = userEvent.setup();
    storeState.conversations[0].mode = 'agent';

    render(<RolesPage />);

    await user.click(screen.getByRole('button', { name: '更多角色操作' }));
    await user.click(screen.getByText('应用到当前会话'));

    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', roleApplyPayload({ mode: 'agent' }));
    expect(localStorage.getItem('aqbot_conv_role_conv-1')).toBe('role-1');
  });

  it('keeps Agent mode when applying a role to an archived Agent conversation', async () => {
    const user = userEvent.setup();
    storeState.conversations = [];
    storeState.archivedConversations = [
      { id: 'conv-1', provider_id: 'provider-1', model_id: 'model-1', system_prompt: null, mode: 'agent' },
    ];

    render(<RolesPage />);

    await user.click(screen.getByRole('button', { name: '更多角色操作' }));
    await user.click(screen.getByText('应用到当前会话'));

    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', roleApplyPayload({ mode: 'agent' }));
  });

  it('does not update the conversation when role binding storage fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });

    render(<RolesPage />);

    await user.click(screen.getByRole('button', { name: '更多角色操作' }));
    await user.click(screen.getByText('应用到当前会话'));

    await waitFor(() => {
      expect(screen.getByText('应用角色失败')).toBeInTheDocument();
    });
    expect(mocks.updateConversation).not.toHaveBeenCalled();
  });

  it('does not apply a role when the active conversation is missing from both lists', async () => {
    const user = userEvent.setup();
    storeState.conversations = [];
    storeState.archivedConversations = [];
    storeState.activeConversationId = 'conv-missing';

    render(<RolesPage />);

    await user.click(screen.getByRole('button', { name: '更多角色操作' }));
    const applyItem = screen.getByRole('menuitem', { name: /应用到当前会话/ });
    expect(applyItem).toHaveAttribute('aria-disabled', 'true');
    await user.click(applyItem);

    expect(mocks.updateConversation).not.toHaveBeenCalled();
  });

  it('rolls back role metadata when updating the conversation fails', async () => {
    const user = userEvent.setup();
    localStorage.setItem('aqbot_conv_role_conv-1', 'old-role');
    localStorage.setItem('aqbot_conv_icon_conv-1', JSON.stringify({ type: 'emoji', value: '🤖' }));
    mocks.updateConversation.mockRejectedValueOnce(new Error('backend down'));

    render(<RolesPage />);

    await user.click(screen.getByRole('button', { name: '更多角色操作' }));
    await user.click(screen.getByText('应用到当前会话'));

    await waitFor(() => {
      expect(screen.getByText('backend down')).toBeInTheDocument();
    });
    expect(localStorage.getItem('aqbot_conv_role_conv-1')).toBe('old-role');
    expect(localStorage.getItem('aqbot_conv_icon_conv-1')).toBe(JSON.stringify({ type: 'emoji', value: '🤖' }));
    expect(mocks.setActivePage).not.toHaveBeenCalled();
  });

  it('enables role skills globally when applying to an Agent conversation', async () => {
    const user = userEvent.setup();
    storeState.conversations[0].mode = 'agent';
    storeState.roles = [{ ...roles[0], enabled_skill_names: ['demo-skill'] }];
    storeState.skills = [{ name: 'demo-skill', enabled: false }];

    render(<RolesPage />);

    await user.click(screen.getByRole('button', { name: '更多角色操作' }));
    await user.click(screen.getByText('应用到当前会话'));

    await waitFor(() => {
      expect(mocks.toggleSkill).toHaveBeenCalledWith('demo-skill', true);
    });
    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      mode: 'agent',
    }));
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

  it('keeps role editor header and footer fixed while body scrolls', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '新建角色' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // antd 6 uses .ant-modal-container (header/footer fixed; body scrolls).
    const container = document.querySelector('.ant-modal-container') as HTMLElement | null;
    const body = document.querySelector('.ant-modal-body') as HTMLElement | null;
    expect(container).toBeTruthy();
    expect(body).toBeTruthy();
    expect(container!.style.maxHeight).toBe('calc(100vh - 48px)');
    expect(container!.style.display).toBe('flex');
    expect(container!.style.flexDirection).toBe('column');
    expect(body!.style.overflowY).toBe('auto');
    expect(body!.style.flex).toMatch(/^1\b/);
  });

  it('uses multi-select controls for MCP and skills', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '新建角色' }));

    expect(screen.getByText('MCP 服务器')).toBeInTheDocument();
    expect(screen.getByText('技能')).toBeInTheDocument();
    // Capability multi-selects use combobox role (searchable Select).
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes.length).toBeGreaterThanOrEqual(2);
  });

  it('shows localized validation when saving an empty role', async () => {
    const user = userEvent.setup();

    render(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '新建角色' }));

    // antd may insert letter-spacing spaces in Chinese button labels (e.g. "保 存").
    const saveButton = Array.from(document.querySelectorAll('button')).find((btn) => {
      const text = (btn.textContent || '').replace(/\s+/g, '');
      return text === '保存' || text === 'Save' || text === 'common.save' || text === 'OK';
    });
    expect(saveButton).toBeTruthy();
    await user.click(saveButton!);

    expect(mocks.createRole).not.toHaveBeenCalled();
    expect(screen.getAllByText('请输入角色名称').length).toBeGreaterThan(0);
    expect(screen.getAllByText('请输入系统提示词').length).toBeGreaterThan(0);
  });

  it('saves an opening question title and multiline content', async () => {
    const user = userEvent.setup();
    mocks.createRole.mockResolvedValue({});

    render(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '新建角色' }));
    fireEvent.change(screen.getByPlaceholderText('请输入角色名称'), { target: { value: '助手' } });
    fireEvent.change(screen.getByPlaceholderText('定义角色的系统提示词（必填）'), { target: { value: '你是助手' } });
    await user.click(screen.getByRole('button', { name: '添加问题' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '翻译' } });
    fireEvent.change(screen.getByLabelText('输入一个开场问题'), { target: { value: '请翻译\n这段话' } });

    const saveButton = Array.from(document.querySelectorAll('button')).find((btn) => {
      const text = (btn.textContent || '').replace(/\s+/g, '');
      return text === '保存' || text === 'Save' || text === 'common.save' || text === 'OK';
    });
    await user.click(saveButton!);

    await waitFor(() => {
      expect(mocks.createRole).toHaveBeenCalled();
    });
    expect(mocks.createRole.mock.calls[0][0].opening_questions).toEqual([
      { title: '翻译', content: '请翻译\n这段话' },
    ]);
  });

  it('round-trips knowledge and memory multi-selects on create and edit', async () => {
    const user = userEvent.setup();
    storeState.bases = [{ id: 'kb-1', name: '产品文档', enabled: true, sortOrder: 0 }];
    storeState.namespaces = [{ id: 'ns-1', name: '项目笔记', scope: 'global', sortOrder: 0 }];
    mocks.createRole.mockResolvedValue({});
    mocks.updateRole.mockResolvedValue({});

    const clickSave = async () => {
      const saveButton = Array.from(document.querySelectorAll('button')).find((btn) => {
        const text = (btn.textContent || '').replace(/\s+/g, '');
        return text === '保存' || text === 'Save' || text === 'common.save' || text === 'OK';
      });
      expect(saveButton).toBeTruthy();
      await user.click(saveButton!);
    };

    const selectFirstOption = async (label: string) => {
      fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
      const option = await screen.findByText((_, node) => (
        node?.classList.contains('ant-select-item-option-content')
        && Boolean(node.textContent?.includes(label === '知识库' ? '产品文档' : '项目笔记'))
      ));
      fireEvent.click(option);
    };

    const view = render(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '新建角色' }));
    fireEvent.change(screen.getByPlaceholderText('请输入角色名称'), { target: { value: '助手' } });
    fireEvent.change(screen.getByPlaceholderText('定义角色的系统提示词（必填）'), { target: { value: '你是助手' } });
    await selectFirstOption('知识库');
    await selectFirstOption('记忆空间');
    await clickSave();

    await waitFor(() => {
      expect(mocks.createRole).toHaveBeenCalled();
    });
    expect(mocks.createRole.mock.calls[0][0].enabled_knowledge_base_ids).toEqual(['kb-1']);
    expect(mocks.createRole.mock.calls[0][0].enabled_memory_namespace_ids).toEqual(['ns-1']);

    storeState.roles = [{
      ...roles[0],
      enabled_knowledge_base_ids: ['kb-1'],
      enabled_memory_namespace_ids: ['ns-1'],
    }];
    view.rerender(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect(within(screen.getByRole('dialog')).getByText('产品文档')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText('项目笔记')).toBeInTheDocument();
    await clickSave();
    await waitFor(() => {
      expect(mocks.updateRole).toHaveBeenCalled();
    });
    expect(mocks.updateRole.mock.calls[0][1].enabled_knowledge_base_ids).toEqual(['kb-1']);
    expect(mocks.updateRole.mock.calls[0][1].enabled_memory_namespace_ids).toEqual(['ns-1']);
  }, 15000);

  it('blocks save when bound knowledge or memory ids are missing', async () => {
    const user = userEvent.setup();
    storeState.roles = [{
      ...roles[0],
      enabled_knowledge_base_ids: ['missing-kb'],
      enabled_memory_namespace_ids: ['missing-ns'],
    }];

    render(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect(within(screen.getByRole('dialog')).getByText('missing-kb')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText('missing-ns')).toBeInTheDocument();

    const saveButton = Array.from(document.querySelectorAll('button')).find((btn) => {
      const text = (btn.textContent || '').replace(/\s+/g, '');
      return text === '保存' || text === 'Save' || text === 'common.save' || text === 'OK';
    });
    await user.click(saveButton!);

    await waitFor(() => {
      expect(screen.getByText('以下绑定已失效，请移除后再保存：missing-kb, missing-ns')).toBeInTheDocument();
    });
    expect(mocks.updateRole).not.toHaveBeenCalled();
    expect(mocks.createRole).not.toHaveBeenCalled();
  });

  it('applies empty knowledge and memory arrays so they overwrite conversation selections', async () => {
    const user = userEvent.setup();
    render(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '更多角色操作' }));
    await user.click(screen.getByText('应用到当前会话'));

    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', roleApplyPayload({
      enabled_knowledge_base_ids: [],
      enabled_memory_namespace_ids: [],
    }));
  });

  it('writes both context arrays when applying a role with bindings', async () => {
    const user = userEvent.setup();
    storeState.roles = [{
      ...roles[0],
      enabled_knowledge_base_ids: ['kb-1'],
      enabled_memory_namespace_ids: ['ns-1'],
    }];
    storeState.bases = [{ id: 'kb-1', name: '产品文档', enabled: true, sortOrder: 0 }];
    storeState.namespaces = [{ id: 'ns-1', name: '项目笔记', scope: 'global', sortOrder: 0 }];

    render(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '更多角色操作' }));
    await user.click(screen.getByText('应用到当前会话'));

    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', roleApplyPayload({
      enabled_knowledge_base_ids: ['kb-1'],
      enabled_memory_namespace_ids: ['ns-1'],
    }));
  });

  it('shows applyCreatedButFailed when a new conversation is created but applying the role fails', async () => {
    const user = userEvent.setup();
    mocks.updateConversation.mockRejectedValueOnce(new Error('backend down'));

    render(<RolesPage />);
    await user.click(screen.getByRole('button', { name: '使用' }));

    await waitFor(() => {
      expect(screen.getByText('会话已创建，角色配置未应用')).toBeInTheDocument();
    });
    expect(screen.queryByText('已应用到当前会话')).not.toBeInTheDocument();
    expect(mocks.createConversation).toHaveBeenCalled();
    expect(mocks.setActivePage).not.toHaveBeenCalled();
  });
});
