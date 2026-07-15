import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContentArea } from '@/components/layout/ContentArea';

vi.mock('@/pages/ChatPage', () => ({
  ChatPage: () => <input aria-label="chat-draft" defaultValue="" />,
}));
vi.mock('@/pages/DrawingPage', () => ({
  DrawingPage: () => <input aria-label="drawing-prompt" defaultValue="" />,
}));
vi.mock('@/pages/KnowledgePage', () => ({ KnowledgePage: () => <div>knowledge</div> }));
vi.mock('@/pages/MemoryPage', () => ({ MemoryPage: () => <div>memory</div> }));
vi.mock('@/pages/GatewayPage', () => ({ GatewayPage: () => <div>gateway</div> }));
vi.mock('@/pages/FilesPage', () => ({ FilesPage: () => <div>files</div> }));
vi.mock('@/pages/SettingsPage', () => ({ SettingsPage: () => <div>settings</div> }));
vi.mock('@/pages/SkillsPage', () => ({ SkillsPage: () => <div>skills</div> }));
vi.mock('@/pages/RolesPage', () => ({
  RolesPage: () => <input aria-label="roles-filter" defaultValue="" />,
}));

describe('ContentArea page lifecycle', () => {
  it('keeps visited chat and drawing page state while switching modules', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ContentArea activePage="chat" />);

    await user.type(screen.getByLabelText('chat-draft'), '保留草稿');
    rerender(<ContentArea activePage="drawing" />);
    await user.type(screen.getByLabelText('drawing-prompt'), '保留提示词');

    rerender(<ContentArea activePage="roles" />);
    expect(screen.getByLabelText('chat-draft')).toHaveValue('保留草稿');
    expect(screen.getByLabelText('drawing-prompt')).toHaveValue('保留提示词');
    expect(screen.getByLabelText('chat-draft')).not.toBeVisible();
    expect(screen.getByLabelText('drawing-prompt')).not.toBeVisible();

    rerender(<ContentArea activePage="chat" />);
    expect(screen.getByLabelText('chat-draft')).toHaveValue('保留草稿');
    expect(screen.getByLabelText('chat-draft')).toBeVisible();

    rerender(<ContentArea activePage="drawing" />);
    expect(screen.getByLabelText('drawing-prompt')).toHaveValue('保留提示词');
    expect(screen.getByLabelText('drawing-prompt')).toBeVisible();
  });

  it('unmounts lightweight pages when navigating away', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ContentArea activePage="roles" />);

    await user.type(screen.getByLabelText('roles-filter'), 'temporary');
    rerender(<ContentArea activePage="knowledge" />);
    expect(screen.queryByLabelText('roles-filter')).not.toBeInTheDocument();

    rerender(<ContentArea activePage="roles" />);
    expect(screen.getByLabelText('roles-filter')).toHaveValue('');
  });
});
