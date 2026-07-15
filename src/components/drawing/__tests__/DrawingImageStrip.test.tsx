import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrawingImage } from '@/types';
import { clearStoredMediaSourceCache } from '@/lib/storedMedia';
import { DrawingImageStrip } from '../DrawingImageStrip';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  isTauri: () => false,
}));

vi.mock('@/lib/chatImageActions', () => ({
  saveChatImage: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

function imageFixture(overrides: Partial<DrawingImage> = {}): DrawingImage {
  return {
    id: 'image-1',
    generation_id: 'generation-1',
    stored_file_id: 'file-1',
    storage_path: 'images/drawing.png',
    mime_type: 'image/png',
    width: 1024,
    height: 1536,
    revised_prompt: null,
    created_at: 1,
    ...overrides,
  };
}

describe('DrawingImageStrip', () => {
  let intersectionCallback: IntersectionObserverCallback | null = null;
  let originalIntersectionObserver: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('data:image/png;base64,abc');
    clearStoredMediaSourceCache();
    originalIntersectionObserver = globalThis.IntersectionObserver;

    class MockIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [];

      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }

      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }

    globalThis.IntersectionObserver = MockIntersectionObserver as typeof IntersectionObserver;
  });

  afterEach(() => {
    globalThis.IntersectionObserver = originalIntersectionObserver as typeof IntersectionObserver;
    intersectionCallback = null;
  });

  it('does not read image previews until the image tile enters the viewport', async () => {
    const { container } = render(
      <DrawingImageStrip
        images={[imageFixture()]}
      />,
    );

    expect(invokeMock).not.toHaveBeenCalled();

    const tile = container.querySelector('.drawing-preview-tile');
    expect(tile).toBeTruthy();
    act(() => {
      intersectionCallback?.([
        { isIntersecting: true, target: tile } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('read_attachment_preview', {
      filePath: 'images/drawing.png',
    }));
  });

  it('sizes the tile to the image ratio so there is no outer frame around the image', async () => {
    const { container } = render(
      <DrawingImageStrip
        images={[imageFixture()]}
      />,
    );

    const tile = container.querySelector('.drawing-preview-tile');
    act(() => {
      intersectionCallback?.([
        { isIntersecting: true, target: tile } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    const image = await screen.findByRole('img');
    const strip = container.querySelector('.drawing-image-strip');

    expect(image).toHaveStyle({ objectFit: 'contain' });
    expect(strip).toHaveClass('overflow-x-auto');
    expect(strip).toHaveClass('w-full');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(tile).toHaveStyle({
      width: '180px',
      height: '270px',
      borderRadius: '6px',
      background: 'transparent',
    });
    expect(container.querySelector('.drawing-image-actions')).toBeNull();
  });

  it('shows hover actions for reference, edit, and mask edit on each image', async () => {
    const onUseAsReference = vi.fn();
    const onEdit = vi.fn();
    const onMaskEdit = vi.fn();
    const { container } = render(
      <DrawingImageStrip
        images={[imageFixture()]}
        onUseAsReference={onUseAsReference}
        onEdit={onEdit}
        onMaskEdit={onMaskEdit}
      />,
    );

    const tile = container.querySelector('.drawing-preview-tile');
    act(() => {
      intersectionCallback?.([
        { isIntersecting: true, target: tile } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    fireEvent.click(await screen.findByRole('button', { name: '作为参考图' }));
    fireEvent.click(screen.getByRole('button', { name: '重新编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '区域编辑' }));

    expect(container.querySelector('.drawing-image-hover-actions')).toBeTruthy();
    expect(onUseAsReference).toHaveBeenCalledWith(expect.objectContaining({
      id: 'image-1',
      storage_path: 'images/drawing.png',
    }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'image-1' }));
    expect(onMaskEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'image-1' }));
  });

  it('uses a wider four-pixel gap between batch images', () => {
    const { container } = render(
      <DrawingImageStrip
        images={[
          imageFixture({ id: 'image-1', storage_path: 'images/one.png' }),
          imageFixture({ id: 'image-2', storage_path: 'images/two.png' }),
        ]}
      />,
    );

    const strip = container.querySelector('.drawing-image-strip');
    expect(strip).toHaveStyle({ gap: '7px' });
  });

  it('renders shimmer placeholders without the old bottom progress bar', () => {
    const { container } = render(
      <DrawingImageStrip
        images={[]}
        loading
        placeholderCount={1}
      />,
    );

    const placeholder = container.querySelector('.drawing-image-placeholder');
    expect(placeholder).toHaveStyle({
      width: '180px',
      height: '300px',
    });
    expect(placeholder?.querySelectorAll(':scope > div')).toHaveLength(1);
  });
});
