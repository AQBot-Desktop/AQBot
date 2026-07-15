import { Activity } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  tauri: true,
}));

vi.mock('@/lib/invoke', () => ({
  invoke: mocks.invoke,
  isTauri: () => mocks.tauri,
}));

import { clearLegacyAvatarSourceCache } from '@/lib/legacyAvatarMedia';
import { useResolvedAvatarSrc } from '../useResolvedAvatarSrc';

function AvatarProbe({ label, value }: { label: string; value: string }) {
  const source = useResolvedAvatarSrc('file', value);
  return <output aria-label={label}>{source ?? 'pending'}</output>;
}

describe('useResolvedAvatarSrc', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.tauri = true;
    clearLegacyAvatarSourceCache();
  });

  it('coalesces consumers, survives Activity reconnects, and reloads after invalidation', async () => {
    mocks.invoke
      .mockResolvedValueOnce('data:image/png;base64,first')
      .mockResolvedValueOnce('data:image/png;base64,second');
    const renderProbes = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <AvatarProbe label="avatar-a" value="images/avatar.png" />
        <AvatarProbe label="avatar-b" value="images/avatar.png" />
        <AvatarProbe label="avatar-c" value="images/avatar.png" />
      </Activity>
    );
    const view = render(renderProbes('visible'));

    await waitFor(() => {
      expect(screen.getAllByText('data:image/png;base64,first')).toHaveLength(3);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('read_attachment_preview', {
      filePath: 'images/avatar.png',
    });

    view.rerender(renderProbes('hidden'));
    view.rerender(renderProbes('visible'));
    await waitFor(() => {
      expect(screen.getAllByText('data:image/png;base64,first')).toHaveLength(3);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    act(() => clearLegacyAvatarSourceCache());
    await waitFor(() => {
      expect(screen.getAllByText('data:image/png;base64,second')).toHaveLength(3);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('returns an inline image source without issuing a legacy preview IPC', () => {
    render(<AvatarProbe label="avatar" value="data:image/png;base64,inline" />);

    expect(screen.getByLabelText('avatar')).toHaveTextContent('data:image/png;base64,inline');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
