import { App } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDrawingStore } from '@/stores/drawingStore';
import type { DrawingImage } from '@/types';
import type { DrawingSettings } from '../DrawingSettingsPanel';
import { DrawingComposer } from '../DrawingComposer';

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

const settingsFixture: DrawingSettings = {
  providerId: 'provider-1',
  modelId: 'gpt-image-2',
  size: 'auto',
  quality: 'auto',
  outputFormat: 'png',
  background: 'auto',
  outputCompression: undefined,
  n: 1,
};

describe('DrawingComposer', () => {
  beforeEach(() => {
    useDrawingStore.setState({
      references: [],
      submitting: false,
      editSourceImage: null,
      editMaskFileId: null,
      editMaskFile: null,
      editPreviewUrl: null,
    });
    invokeMock.mockReset();
  });

  it('submits a pending mask edit through editImageWithMask after the prompt is entered', async () => {
    const editImage = vi.fn().mockResolvedValue({});
    const editImageWithMask = vi.fn().mockResolvedValue({});
    const generateImages = vi.fn().mockResolvedValue({});
    const onPromptChange = vi.fn();

    useDrawingStore.setState({
      editSourceImage: imageFixture(),
      editMaskFileId: 'mask-1',
      editMaskFile: {
        id: 'mask-1',
        original_name: 'mask.png',
        mime_type: 'image/png',
        size_bytes: 128,
        storage_path: 'images/mask.png',
      },
      editPreviewUrl: 'data:image/png;base64,masked-preview',
      editImage,
      editImageWithMask,
      generateImages,
    });

    render(
      <App>
        <DrawingComposer
          settings={settingsFixture}
          prompt="替换涂抹区域"
          onPromptChange={onPromptChange}
        />
      </App>,
    );

    expect(screen.getByText('区域编辑模式')).toBeDefined();
    expect(screen.getByAltText('编辑预览')).toBeDefined();

    fireEvent.keyDown(screen.getByPlaceholderText('输入你想生成的画面'), {
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false },
    });

    await waitFor(() => {
      expect(editImageWithMask).toHaveBeenCalledWith(expect.objectContaining({
        source_image_id: 'image-1',
        mask_file_id: 'mask-1',
        prompt: '替换涂抹区域',
      }));
    });
    expect(editImage).not.toHaveBeenCalled();
    expect(generateImages).not.toHaveBeenCalled();
    expect(onPromptChange).toHaveBeenCalledWith('');
  });

  it('loads the source image thumbnail for normal edit mode', async () => {
    invokeMock.mockResolvedValue('data:image/png;base64,source-preview');

    useDrawingStore.setState({
      editSourceImage: imageFixture(),
      editMaskFileId: null,
      editMaskFile: null,
      editPreviewUrl: null,
    });

    render(
      <App>
        <DrawingComposer
          settings={settingsFixture}
          prompt=""
          onPromptChange={() => {}}
        />
      </App>,
    );

    await waitFor(() => {
      expect(screen.getByAltText('编辑预览')).toBeDefined();
    });
    expect(invokeMock).toHaveBeenCalledWith('read_attachment_preview', { filePath: 'images/drawing.png' });
  });

  it('reports composer height so the history list can reserve enough bottom space', async () => {
    const onHeightChange = vi.fn();
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        width: 600,
        height: 232,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 600,
        bottom: 232,
        toJSON: () => ({}),
      } as DOMRect);

    render(
      <App>
        <DrawingComposer
          settings={settingsFixture}
          prompt=""
          onPromptChange={() => {}}
          onHeightChange={onHeightChange}
        />
      </App>,
    );

    await waitFor(() => expect(onHeightChange).toHaveBeenCalledWith(232));
    rectSpy.mockRestore();
  });
});
