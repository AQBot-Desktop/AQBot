import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationModelIcon } from '../ConversationModelIcon';

vi.mock('@lobehub/icons', () => ({
  modelMappings: [{ keywords: ['deepseek'] }],
  ModelIcon: ({ model, size }: { model: string; size: number }) => (
    <span data-testid="model-icon" data-model={model} data-size={size} />
  ),
}));

vi.mock('lucide-react', () => ({
  Brain: ({ size, strokeWidth }: { size: number; strokeWidth: number }) => (
    <span data-testid="brain-icon" data-size={size} data-stroke-width={strokeWidth} />
  ),
}));

describe('ConversationModelIcon', () => {
  it('wraps model avatars in a fixed centered box', () => {
    render(<ConversationModelIcon model="deepseek-chat" size={20} />);

    const wrapper = screen.getByTestId('model-icon').parentElement;
    expect(wrapper).toHaveClass('aqbot-conversation-model-icon');
    expect(wrapper).toHaveStyle({
      width: '20px',
      height: '20px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: '50%',
    });
  });

  it('uses a centered local fallback for unknown model avatars', () => {
    render(<ConversationModelIcon model="unknown-model" size={20} />);

    expect(screen.queryByTestId('model-icon')).not.toBeInTheDocument();

    const avatar = screen.getByTestId('brain-icon').closest('.aqbot-conversation-model-icon');
    expect(avatar).toHaveClass('aqbot-conversation-model-icon');
    expect(avatar).toHaveStyle({
      width: '20px',
      height: '20px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
  });
});
