import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrawingImage } from '@/types';
import { DrawingImageStrip } from '../DrawingImageStrip';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
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
      width: '132px',
      height: '198px',
      borderRadius: '6px',
      background: 'transparent',
    });
    expect(container.querySelector('.drawing-image-actions')).toBeNull();
    expect(container.querySelector('.drawing-image-action-buttons')).toBeNull();
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
    expect(strip).toHaveClass('gap-1');
    expect(strip).not.toHaveClass('gap-px');
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
      width: '250px',
      height: '198px',
    });
    expect(placeholder?.querySelectorAll(':scope > div')).toHaveLength(1);
  });
});
