import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsPage } from '../SkillsPage';
import type { MarketplaceSkill, Skill } from '@/types';

const mocks = vi.hoisted(() => ({
  ensureSkillsLoaded: vi.fn(),
  loadSkills: vi.fn(),
  getSkill: vi.fn(),
  toggleSkill: vi.fn(),
  installSkill: vi.fn(),
  uninstallSkill: vi.fn(),
  uninstallSkillGroup: vi.fn(),
  openSkillDir: vi.fn(),
  searchMarketplace: vi.fn(),
  clearSelectedSkill: vi.fn(),
}));

const marketplaceSkills: MarketplaceSkill[] = [
  {
    name: 'frontend-design',
    description: 'Frontend design skill',
    repo: 'vercel-labs/agent-skills',
    skillId: 'frontend-design',
    installRef: 'vercel-labs/agent-skills@frontend-design',
    stars: 0,
    installs: 12,
    installed: false,
  },
];

const skills: Skill[] = [
  {
    name: 'aqbot-skill',
    description: 'AQBot skill',
    source: 'aqbot',
    sourcePath: '/Users/test/.aqbot/skills/aqbot-skill/SKILL.md',
    enabled: true,
    hasUpdate: false,
    userInvocable: true,
  },
  {
    name: 'codex-skill',
    description: 'Codex skill',
    source: 'codex',
    sourcePath: '/Users/test/.codex/skills/codex-skill/SKILL.md',
    enabled: true,
    hasUpdate: false,
    userInvocable: true,
  },
];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'skills.mySkills': 'My Skills',
        'skills.marketplace': 'Marketplace',
        'skills.installUrlPlaceholder': 'Enter owner/repo or GitHub URL',
        'skills.install': 'Install',
        'skills.installFromUrl': 'Install from URL',
        'skills.searchMarketplace': 'Search marketplace',
        'skills.sourceAll': 'All',
        'skills.openDir': 'Open Directory',
        'skills.empty': 'No Skills',
        'skills.emptyDesc': 'No skills yet',
        'skills.source.aqbot': 'AQBot',
        'skills.source.codex': 'Codex',
        'skills.source.claude': 'Claude',
        'skills.source.agents': 'Agents',
        'skills.uninstallConfirm': `Uninstall ${opts?.name}`,
        'skills.uninstall': 'Uninstall',
        'common.cancel': 'Cancel',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('@lobehub/icons', () => ({
  Claude: {
    Color: () => <span />,
  },
  Codex: {
    Avatar: () => <span />,
    Color: () => <span />,
  },
}));

vi.mock('@/stores', () => ({
  useSkillStore: () => ({
    skills,
    marketplaceSkills,
    loading: false,
    marketplaceLoading: false,
    selectedSkill: null,
    ensureSkillsLoaded: mocks.ensureSkillsLoaded,
    loadSkills: mocks.loadSkills,
    getSkill: mocks.getSkill,
    toggleSkill: mocks.toggleSkill,
    installSkill: mocks.installSkill,
    uninstallSkill: mocks.uninstallSkill,
    uninstallSkillGroup: mocks.uninstallSkillGroup,
    openSkillDir: mocks.openSkillDir,
    searchMarketplace: mocks.searchMarketplace,
    clearSelectedSkill: mocks.clearSelectedSkill,
  }),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn(async () => '/Users/test/'),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: vi.fn(),
  openUrl: vi.fn(),
}));

describe('SkillsPage Codex source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters skills by Codex source', async () => {
    const user = userEvent.setup();

    render(<SkillsPage />);

    await user.click(screen.getByRole('tab', { name: /Codex/ }));

    expect(screen.getByText('codex-skill')).toBeInTheDocument();
    expect(screen.queryByText('aqbot-skill')).not.toBeInTheDocument();
    expect(screen.getByText('~/.codex/skills/')).toBeInTheDocument();
  });

  it('offers Codex as an install target', async () => {
    const user = userEvent.setup();

    render(<SkillsPage />);

    await user.type(screen.getByPlaceholderText('Enter owner/repo or GitHub URL'), 'owner/repo');
    await user.click(screen.getByRole('button', { name: 'Install from URL' }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Codex')).toBeInTheDocument();
    expect(within(menu).getByText('~/.codex/skills/')).toBeInTheDocument();
  });

  it('shows brand icons for every install target', async () => {
    const user = userEvent.setup();

    render(<SkillsPage />);

    await user.type(screen.getByPlaceholderText('Enter owner/repo or GitHub URL'), 'owner/repo');
    await user.click(screen.getByRole('button', { name: 'Install from URL' }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByTestId('aqbot-icon')).toBeInTheDocument();
    expect(within(menu).getByTestId('codex-icon')).toBeInTheDocument();
    expect(within(menu).getByTestId('claude-icon')).toBeInTheDocument();
    expect(within(menu).getByTestId('agents-icon')).toBeInTheDocument();
  });
});

describe('SkillsPage marketplace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.installSkill.mockResolvedValue('frontend-design');
  });

  it('installs a marketplace skill as owner/repo@skill', async () => {
    const user = userEvent.setup();

    render(<SkillsPage />);

    await user.click(screen.getByRole('tab', { name: /Marketplace/ }));

    expect(mocks.searchMarketplace).toHaveBeenCalled();
    expect(screen.getByText('frontend-design')).toBeInTheDocument();
    expect(screen.getByText('vercel-labs/agent-skills@frontend-design')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Install' }));
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByText('AQBot'));

    await waitFor(() => {
      expect(mocks.installSkill).toHaveBeenCalledWith(
        'vercel-labs/agent-skills@frontend-design',
        'aqbot',
      );
    });
  });
});
