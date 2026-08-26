import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { StreamingStatusIndicator } from '../StreamingStatusIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('StreamingStatusIndicator', () => {
  beforeEach(() => {
    useConversationStore.setState({
      streaming: true,
      streamActivityByMessageId: {
        live: {
          startedAt: Date.now(),
          firstChunkAt: Date.now(),
          lastChunkAt: Date.now(),
          phase: 'streaming',
        },
      },
    });
  });

  it('shows generating status for the streaming message', () => {
    render(<StreamingStatusIndicator messageId="live" hasModelText />);
    expect(screen.getByLabelText('chat.streamingStatus.generating')).toBeInTheDocument();
  });

  it('hides when the conversation is not streaming', () => {
    act(() => {
      useConversationStore.setState({ streaming: false });
    });
    const { container } = render(<StreamingStatusIndicator messageId="live" hasModelText />);
    expect(container).toBeEmptyDOMElement();
  });
});
