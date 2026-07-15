import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileList } from '../FileList';

const { loadStoredMediaSourceMock } = vi.hoisted(() => ({
  loadStoredMediaSourceMock: vi.fn(),
}));

vi.mock('@/lib/storedMedia', () => ({
  loadStoredMediaSource: loadStoredMediaSourceMock,
}));

describe('FileList image thumbnails', () => {
  beforeEach(() => {
    loadStoredMediaSourceMock.mockReset();
  });

  it('loads a thumbnail with the raw stored-file id and relative storage path', async () => {
    loadStoredMediaSourceMock.mockResolvedValue('aqbot-media://stored/stored-image-1');

    const { container } = render(<FileList category="images" rows={[{
      id: 'attachment::stored-image-1',
      storedFileId: 'stored-image-1',
      name: 'preview.png',
      path: '/tmp/preview.png',
      storagePath: 'images/preview.png',
      missing: false,
    }]} />);

    await waitFor(() => expect(loadStoredMediaSourceMock).toHaveBeenCalledWith(
      'stored-image-1',
      'images/preview.png',
    ));
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute(
      'src', 'aqbot-media://stored/stored-image-1',
    ));
  });

  it('surfaces thumbnail failures instead of swallowing them', async () => {
    loadStoredMediaSourceMock.mockRejectedValue(new Error('media protocol rejected the file'));

    render(<FileList category="images" rows={[{
      id: 'attachment::stored-image-2',
      storedFileId: 'stored-image-2',
      name: 'broken.png',
      path: '/tmp/broken.png',
      storagePath: 'images/broken.png',
      missing: false,
    }]} />);

    const error = await screen.findByTestId('thumbnail-error-attachment::stored-image-2');
    expect(error).toHaveAttribute('aria-label', expect.stringContaining('media protocol rejected'));
  });
});
