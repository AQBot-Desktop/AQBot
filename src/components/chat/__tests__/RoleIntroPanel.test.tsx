import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RoleIntroPanel } from '../RoleIntroPanel';

describe('RoleIntroPanel', () => {
  it('shows the title and sends the full content', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <RoleIntroPanel
        intro={{
          openingMessage: '你好',
          openingQuestions: [{ title: '翻译', content: '请翻译\n这段话' }],
        }}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText('你好')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '翻译' })).toBeInTheDocument();
    expect(screen.queryByText('请翻译')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '翻译' }));
    expect(onSelect).toHaveBeenCalledWith('请翻译\n这段话');
  });

  it('falls back to the first non-empty content line when title is missing', () => {
    render(
      <RoleIntroPanel
        intro={{
          openingMessage: null,
          openingQuestions: [{ title: null, content: '\n  第一行有效内容  \n第二行' }],
        }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '第一行有效内容' })).toBeInTheDocument();
  });

  it('reveals the full content on hover without sending it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <RoleIntroPanel
        intro={{
          openingMessage: null,
          openingQuestions: [{ title: '翻译', content: '请翻译\n这段话' }],
        }}
        onSelect={onSelect}
      />,
    );

    await user.hover(screen.getByRole('button', { name: '翻译' }));
    expect(await screen.findByTestId('role-intro-preview')).toHaveTextContent('请翻译');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
