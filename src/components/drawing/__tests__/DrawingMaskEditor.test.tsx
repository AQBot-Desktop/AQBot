import { App } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrawingImage } from '@/types';
import {
  DrawingMaskEditor,
  getEraserFeedbackStyle,
  getMaskBrushStyle,
  overlayAlphaToMaskAlpha,
} from '../DrawingMaskEditor';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

function imageFixture(): DrawingImage {
  return {
    id: 'image-1',
    generation_id: 'generation-1',
    stored_file_id: 'file-1',
    storage_path: 'images/drawing.png',
    mime_type: 'image/png',
    width: 1024,
    height: 1024,
    revised_prompt: null,
    created_at: 1,
  };
}

describe('DrawingMaskEditor', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('keeps the modal and image editor within the viewport margins', () => {
    invokeMock.mockResolvedValue('data:image/png;base64,abc');

    render(
      <App>
        <DrawingMaskEditor
          open
          image={imageFixture()}
          onApply={() => {}}
          onClose={() => {}}
        />
      </App>,
    );

    expect(document.querySelector('.ant-modal')).toHaveStyle({
      top: '24px',
      maxWidth: 'calc(100vw - 48px)',
    });
    expect(document.querySelector('.ant-modal-body')).toHaveStyle({
      maxHeight: 'calc(100vh - 160px)',
      overflow: 'hidden',
    });
    expect(screen.getByTestId('drawing-mask-editor-surface')).toHaveStyle({
      maxHeight: 'calc(100vh - 220px)',
      overflow: 'hidden',
    });
  });

  it('uses the theme color for painted mask pixels and keeps eraser removal fully opaque', () => {
    expect(getMaskBrushStyle(false)).toEqual({
      compositeOperation: 'source-over',
      fillStyle: '#1677ff',
      globalAlpha: 0.42,
    });
    expect(getMaskBrushStyle(false, '#22c55e')).toEqual({
      compositeOperation: 'source-over',
      fillStyle: '#22c55e',
      globalAlpha: 0.42,
    });
    expect(getMaskBrushStyle(true, '#22c55e')).toEqual({
      compositeOperation: 'destination-out',
      fillStyle: '#000000',
      globalAlpha: 1,
    });
    expect(getEraserFeedbackStyle('#22c55e')).toEqual({
      compositeOperation: 'source-over',
      fillStyle: '#22c55e',
      globalAlpha: 0.24,
    });
  });

  it('exports painted overlay pixels as transparent mask pixels and erased pixels as opaque mask pixels', () => {
    expect(overlayAlphaToMaskAlpha(0)).toBe(255);
    expect(overlayAlphaToMaskAlpha(1)).toBe(0);
    expect(overlayAlphaToMaskAlpha(107)).toBe(0);
    expect(overlayAlphaToMaskAlpha(255)).toBe(0);
  });

  it('uploads the mask and hands it back without generating immediately', async () => {
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray([0, 0, 0, 107, 0, 0, 0, 0]),
      })),
      createImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(8),
      })),
      putImageData: vi.fn(),
      set fillStyle(_value: string) {},
      set globalCompositeOperation(_value: string) {},
      set globalAlpha(_value: number) {},
    } as unknown as CanvasRenderingContext2D));
    const toDataUrlSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,mask-data');
    const onApply = vi.fn();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'upload_drawing_reference') {
        return Promise.resolve({
          id: 'mask-1',
          original_name: 'mask-image-1.png',
          mime_type: 'image/png',
          size_bytes: 128,
          storage_path: 'images/mask-image-1.png',
        });
      }
      return Promise.resolve('data:image/png;base64,abc');
    });

    render(
      <App>
        <DrawingMaskEditor
          open
          image={imageFixture()}
          onApply={onApply}
          onClose={() => {}}
        />
      </App>,
    );

    fireEvent.click(screen.getByRole('button', { name: '提交区域编辑' }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalled();
    });
    expect(onApply.mock.calls[0]?.[0]).toEqual(imageFixture());
    expect(onApply.mock.calls[0]?.[1]).toMatchObject({
      id: 'mask-1',
      storage_path: 'images/mask-image-1.png',
    });
    expect(invokeMock).toHaveBeenCalledWith('upload_drawing_reference', {
      input: {
        data: 'mask-data',
        file_name: 'mask-image-1.png',
        mime_type: 'image/png',
      },
    });
    expect(invokeMock).not.toHaveBeenCalledWith('edit_drawing_image_with_mask', expect.anything());

    getContextSpy.mockRestore();
    toDataUrlSpy.mockRestore();
  });
});
