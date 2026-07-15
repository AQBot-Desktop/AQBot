import { App } from 'antd';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as storedMedia from '@/lib/storedMedia';
import { clearStoredMediaSourceCache } from '@/lib/storedMedia';
import { useDrawingStore } from '@/stores/drawingStore';
import { DrawingReferenceUploader } from '../DrawingReferenceUploader';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  isTauri: () => false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

describe('DrawingReferenceUploader', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('data:image/png;base64,abc');
    clearStoredMediaSourceCache();
    useDrawingStore.setState({
      references: [{
        id: 'reference-file-1',
        original_name: 'reference.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        storage_path: 'images/reference.png',
      }],
    });
  });

  it('loads the thumbnail with the stored file id and relative storage path', async () => {
    const loadSourceSpy = vi.spyOn(storedMedia, 'loadStoredMediaSource');

    render(
      <App>
        <DrawingReferenceUploader />
      </App>,
    );

    expect(screen.getByText('reference.png')).toBeDefined();
    await waitFor(() => {
      expect(loadSourceSpy).toHaveBeenCalledWith('reference-file-1', 'images/reference.png');
    });
    loadSourceSpy.mockRestore();
  });
});
