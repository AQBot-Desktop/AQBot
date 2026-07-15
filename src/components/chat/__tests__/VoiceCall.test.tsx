import type { ReactNode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeConfig } from '@/types';
import { VoiceCall } from '../VoiceCall';

const voiceChatMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useVoiceChat', () => ({
  useVoiceChat: voiceChatMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  Spin: () => <span>loading</span>,
  Typography: {
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  },
}));

const config: RealtimeConfig = {
  model_id: 'voice-model',
  voice: null,
  audio_format: { sample_rate: 24_000, channels: 1, encoding: 'Pcm16' },
};

describe('VoiceCall lifecycle', () => {
  const start = vi.fn(async () => {});
  const stop = vi.fn();

  beforeEach(() => {
    start.mockClear();
    stop.mockClear();
    voiceChatMock.mockReturnValue({
      state: 'Idle',
      isMuted: false,
      start,
      stop,
      toggleMute: vi.fn(),
    });
  });

  it('does not start a voice session during render', () => {
    renderToString(<VoiceCall visible onClose={vi.fn()} config={config} />);

    expect(start).not.toHaveBeenCalled();
  });

  it('starts from an effect and stops when the overlay becomes hidden', async () => {
    const { rerender } = render(<VoiceCall visible onClose={vi.fn()} config={config} />);

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    rerender(<VoiceCall visible={false} onClose={vi.fn()} config={config} />);

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
