import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

describe('drawingStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const { useDrawingStore } = await import('../drawingStore');
    useDrawingStore.setState({
      generations: [],
      references: [],
      loading: false,
      submitting: false,
      error: null,
      editSourceImage: null,
    });
  });

  it('loads drawing history from the drawing-only backend command', async () => {
    invokeMock.mockResolvedValueOnce([]);
    const { useDrawingStore } = await import('../drawingStore');

    await useDrawingStore.getState().loadHistory();

    expect(invokeMock).toHaveBeenCalledWith('list_drawing_generations', {
      limit: 30,
      cursor: undefined,
    });
  });

  it('passes the API-supported maximum batch count through generateImages', async () => {
    invokeMock.mockResolvedValueOnce({ id: 'generation-1', images: [] });
    const { useDrawingStore } = await import('../drawingStore');

    await useDrawingStore.getState().generateImages({
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      prompt: '生成 10 张图',
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
      background: 'auto',
      n: 10,
      reference_file_ids: [],
    });

    expect(invokeMock).toHaveBeenCalledWith('generate_drawing_images', {
      input: expect.objectContaining({ n: 10 }),
    });
  });

  it('sends mask edits through the dedicated mask edit command', async () => {
    invokeMock.mockResolvedValueOnce({ id: 'generation-2', images: [] });
    const { useDrawingStore } = await import('../drawingStore');

    await useDrawingStore.getState().editImageWithMask({
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      prompt: '只替换涂抹区域',
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
      background: 'auto',
      n: 1,
      source_image_id: 'image-1',
      mask_file_id: 'mask-1',
      reference_file_ids: [],
    });

    expect(invokeMock).toHaveBeenCalledWith('edit_drawing_image_with_mask', {
      input: expect.objectContaining({
        source_image_id: 'image-1',
        mask_file_id: 'mask-1',
      }),
    });
  });
});
