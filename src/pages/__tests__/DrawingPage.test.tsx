import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContentArea } from '@/components/layout/ContentArea';

vi.mock('@/pages/ChatPage', () => ({ ChatPage: () => <div>chat</div> }));
vi.mock('@/pages/KnowledgePage', () => ({ KnowledgePage: () => <div>knowledge</div> }));
vi.mock('@/pages/MemoryPage', () => ({ MemoryPage: () => <div>memory</div> }));
vi.mock('@/pages/GatewayPage', () => ({ GatewayPage: () => <div>gateway</div> }));
vi.mock('@/pages/FilesPage', () => ({ FilesPage: () => <div>files</div> }));
vi.mock('@/pages/SettingsPage', () => ({ SettingsPage: () => <div>settings</div> }));
vi.mock('@/pages/SkillsPage', () => ({ SkillsPage: () => <div>skills</div> }));
vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <span>provider-icon</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    theme: {
      ...actual.theme,
      useToken: () => ({
        token: {
          colorBgContainer: '#ffffff',
          colorBgElevated: '#ffffff',
          colorBgLayout: '#0f172a',
          colorBorderSecondary: '#e5e7eb',
          colorFillAlter: '#f6f8fa',
          colorFillSecondary: '#f3f4f6',
          colorPrimary: '#1677ff',
          colorPrimaryBg: '#e6f4ff',
          colorText: '#111827',
          colorTextBase: '#111827',
          colorTextSecondary: '#6b7280',
        },
      }),
    },
  };
});

describe('DrawingPage routing', () => {
  it('renders the drawing page from ContentArea', () => {
    const { container } = render(<ContentArea activePage="drawing" />);

    expect(screen.getByText('绘画')).toBeDefined();
    expect(screen.queryByText('绘画设置')).toBeNull();
    expect(screen.getByTestId('drawing-generation-list')).toBeDefined();
    expect(screen.getByTestId('drawing-composer')).toBeDefined();
    expect(container.firstElementChild).toHaveStyle({ background: '#0f172a' });
    expect(screen.queryByRole('button', { name: '参考图' })).toBeNull();

    const composer = screen.getByTestId('drawing-composer');
    expect(composer.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(composer.style.border).toBe('1px solid var(--border-color)');
    expect(composer.style.borderRadius).toBe('16px');
    expect(composer.querySelector('textarea')).toHaveClass('aqbot-input-textarea');
  });
});
