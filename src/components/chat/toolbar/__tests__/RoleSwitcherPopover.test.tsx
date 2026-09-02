import { App } from 'antd';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@/types';
import { RoleSwitcherPopover } from '../RoleSwitcherPopover';

const mocks = vi.hoisted(() => ({
  ensureRolesLoaded: vi.fn(),
  updateConversation: vi.fn(),
  createConversation: vi.fn(),
  setActiveConversation: vi.fn(),
  setActivePage: vi.fn(),
  ensureSkillsLoaded: vi.fn(),
  toggleSkill: vi.fn(),
}));

const role: Role = {
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
  source_kind: 'local',
  source_ref: null,
  created_at: 1,
  updated_at: 1,
};

type ConversationStub = {
  id: string;
  provider_id: string;
  model_id: string;
  system_prompt: string | null;
  mode: 'chat' | 'agent' | 'role' | undefined;
};

const storeState = vi.hoisted(() => ({
  roles: [] as Role[],
  activeConversationId: 'conv-1' as string | null,
  conversations: [] as ConversationStub[],
  archivedConversations: [] as ConversationStub[],
  skills: [] as Array<{ name: string; enabled: boolean }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'chat.role.title': '角色',
        'chat.role.apply': '应用',
        'chat.role.new': '新建',
        'chat.role.manage': '管理角色',
        'roles.applyToCurrent': '应用到当前会话',
        'roles.newConversation': '新建会话并使用',
        'roles.searchPlaceholder': '搜索角色',
        'roles.emptyDesc': '还没有角色',
        'roles.applyFailed': '应用角色失败',
        'roles.conversationMissing': '当前会话不存在，无法应用角色',
        'chat.role.bindingReadFailed': '读取角色绑定失败',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('@/hooks/useResolvedAvatarSrc', () => ({
  useResolvedAvatarSrc: () => null,
}));

vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector?: (state: { setActivePage: typeof mocks.setActivePage }) => unknown) => {
    const state = { setActivePage: mocks.setActivePage };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/stores', () => ({
  useRoleStore: (selector?: (state: any) => unknown) => {
    const state = {
      roles: storeState.roles,
      ensureRolesLoaded: mocks.ensureRolesLoaded,
    };
    return selector ? selector(state) : state;
  },
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
}));

async function openSwitcher() {
  const user = userEvent.setup();
  render(
    <App>
      <RoleSwitcherPopover />
    </App>,
  );
  await user.click(screen.getByRole('button', { name: '角色' }));
  expect(await screen.findAllByRole('button', { name: '应用' })).not.toHaveLength(0);
  return user;
}

describe('RoleSwitcherPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    localStorage.clear();
    mocks.ensureRolesLoaded.mockResolvedValue(undefined);
    mocks.ensureSkillsLoaded.mockResolvedValue(undefined);
    mocks.toggleSkill.mockResolvedValue(undefined);
    storeState.roles = [role];
    storeState.activeConversationId = 'conv-1';
    storeState.conversations = [
      { id: 'conv-1', provider_id: 'provider-1', model_id: 'model-1', system_prompt: null, mode: undefined },
    ];
    storeState.archivedConversations = [];
    storeState.skills = [];
  });

  it('keeps Agent mode when applying a role to the active Agent conversation', async () => {
    storeState.conversations[0].mode = 'agent';
    const user = await openSwitcher();

    await user.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', {
        system_prompt: '你是中文翻译助手',
        temperature: 0.2,
        top_p: 0.8,
        mode: 'agent',
      });
    });
  });

  it('keeps Agent mode when applying a role to an archived Agent conversation', async () => {
    storeState.conversations = [];
    storeState.archivedConversations = [
      { id: 'conv-1', provider_id: 'provider-1', model_id: 'model-1', system_prompt: null, mode: 'agent' },
    ];
    const user = await openSwitcher();

    await user.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', {
        system_prompt: '你是中文翻译助手',
        temperature: 0.2,
        top_p: 0.8,
        mode: 'agent',
      });
    });
  });

  it('does not apply a role when the active conversation is missing from both lists', async () => {
    storeState.conversations = [];
    storeState.archivedConversations = [];
    storeState.activeConversationId = 'conv-missing';
    const user = await openSwitcher();

    const applyButton = screen.getByRole('button', { name: '应用' });
    expect(applyButton).toBeDisabled();
    await user.click(applyButton);

    expect(mocks.updateConversation).not.toHaveBeenCalled();
  });

  it('highlights the bound role in the toolbar switcher', async () => {
    localStorage.setItem('aqbot_conv_role_conv-1', 'role-1');
    await openSwitcher();

    expect(screen.getByText('中文翻译助手').closest('[data-active]')).toHaveAttribute('data-active', 'true');
  });

  it('refreshes the toolbar highlight when a retained chat receives an external role update', async () => {
    storeState.conversations = [{ ...storeState.conversations[0], mode: 'agent' }];
    const view = render(
      <App>
        <RoleSwitcherPopover />
      </App>,
    );

    expect(screen.getByRole('button', { name: '角色' }).style.color).toBe('');

    localStorage.setItem('aqbot_conv_role_conv-1', 'role-1');
    storeState.conversations = [
      { ...storeState.conversations[0], system_prompt: role.system_prompt },
    ];
    view.rerender(
      <App>
        <RoleSwitcherPopover />
      </App>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '角色' }).style.color).not.toBe('');
    });
  });

  it('highlights the newly applied role after the switcher is reopened', async () => {
    const previousRole: Role = {
      ...role,
      id: 'role-2',
      name: '代码助手',
      description: '写代码',
      system_prompt: '你是代码助手',
    };
    storeState.roles = [role, previousRole];
    localStorage.setItem('aqbot_conv_role_conv-1', 'role-2');
    const user = await openSwitcher();

    expect(screen.getByText('代码助手').closest('[data-active]')).toHaveAttribute('data-active', 'true');
    expect(screen.getByText('中文翻译助手').closest('[data-active]')).toHaveAttribute('data-active', 'false');

    const currentRow = screen.getByText('中文翻译助手').closest('[data-active]');
    expect(currentRow).toBeTruthy();
    await user.click(within(currentRow as HTMLElement).getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(mocks.updateConversation).toHaveBeenCalled();
    });

    await user.click(screen.getByRole('button', { name: '角色' }));
    expect(await screen.findByText('中文翻译助手')).toBeInTheDocument();
    expect(screen.getByText('中文翻译助手').closest('[data-active]')).toHaveAttribute('data-active', 'true');
    expect(screen.getByText('代码助手').closest('[data-active]')).toHaveAttribute('data-active', 'false');
  });

  it('enables role skills and writes full metadata when applying to the current conversation', async () => {
    storeState.conversations[0].mode = 'agent';
    storeState.roles = [{ ...role, enabled_skill_names: ['demo-skill'] }];
    storeState.skills = [{ name: 'demo-skill', enabled: false }];
    const user = await openSwitcher();

    await user.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(mocks.toggleSkill).toHaveBeenCalledWith('demo-skill', true);
    });
    expect(mocks.updateConversation).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      mode: 'agent',
      system_prompt: '你是中文翻译助手',
    }));
    expect(localStorage.getItem('aqbot_conv_role_conv-1')).toBe('role-1');
    expect(localStorage.getItem('aqbot_conv_icon_conv-1')).toBe(JSON.stringify({ type: 'emoji', value: '🌐' }));
    expect(JSON.parse(localStorage.getItem('aqbot_role_intro_conv-1') ?? '{}')).toEqual({
      openingMessage: '发来文本',
      openingQuestions: ['翻译这段话'],
      openingQuestionItems: [{ title: null, content: '翻译这段话' }],
    });
  });

  it('rolls back role metadata when updating the conversation fails', async () => {
    localStorage.setItem('aqbot_conv_role_conv-1', 'old-role');
    localStorage.setItem('aqbot_conv_icon_conv-1', JSON.stringify({ type: 'emoji', value: '🤖' }));
    mocks.updateConversation.mockRejectedValueOnce(new Error('backend down'));
    const user = await openSwitcher();

    await user.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(screen.getByText('应用角色失败')).toBeInTheDocument();
    });
    expect(localStorage.getItem('aqbot_conv_role_conv-1')).toBe('old-role');
    expect(localStorage.getItem('aqbot_conv_icon_conv-1')).toBe(JSON.stringify({ type: 'emoji', value: '🤖' }));
  });

  it('surfaces a binding read failure instead of treating the role as unbound', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (String(key).includes('aqbot_conv_role_')) throw new Error('denied');
      return null;
    });
    await openSwitcher();

    expect(await screen.findAllByText('读取角色绑定失败')).not.toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    expect(screen.getByText('中文翻译助手').closest('[data-active]')).toHaveAttribute('data-active', 'false');
  });

  it('does not update the conversation when role binding storage fails', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const user = await openSwitcher();

    await user.click(screen.getByRole('button', { name: '应用' }));

    await waitFor(() => {
      expect(screen.getByText('应用角色失败')).toBeInTheDocument();
    });
    expect(mocks.updateConversation).not.toHaveBeenCalled();
  });
});
