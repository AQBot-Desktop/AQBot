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
      editMaskFileId: null,
      editMaskFile: null,
      editPreviewUrl: null,
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

  it('deduplicates concurrent history loads and treats an empty result as loaded', async () => {
    let resolveHistory: (value: unknown[]) => void = () => {};
    invokeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveHistory = resolve;
    }));
    const { useDrawingStore } = await import('../drawingStore');

    const first = useDrawingStore.getState().ensureHistoryLoaded();
    const second = useDrawingStore.getState().ensureHistoryLoaded();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveHistory([]);
    await Promise.all([first, second]);
    await useDrawingStore.getState().ensureHistoryLoaded();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useDrawingStore.getState().historyMeta.status).toBe('ready');
  });

  it('reloads drawing history only after explicit invalidation', async () => {
    invokeMock.mockResolvedValue([]);
    const { useDrawingStore } = await import('../drawingStore');

    await useDrawingStore.getState().ensureHistoryLoaded();
    useDrawingStore.getState().invalidateHistory('restore');
    await useDrawingStore.getState().ensureHistoryLoaded();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useDrawingStore.getState().historyMeta.revision).toBe(1);
  });

  it('merges an optimistic generation created while history is loading', async () => {
    let resolveHistory: (value: unknown[]) => void = () => {};
    let resolveGeneration: (value: unknown) => void = () => {};
    invokeMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveHistory = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveGeneration = resolve; }));
    const { useDrawingStore } = await import('../drawingStore');

    const historyPromise = useDrawingStore.getState().ensureHistoryLoaded();
    const generationPromise = useDrawingStore.getState().generateImages({
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      prompt: '并发绘画',
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
      background: 'auto',
      n: 1,
      reference_image_mode: 'multipart',
      reference_image_format: 'object',
      reference_image_param_name: 'images',
      reference_file_ids: [],
    });
    const optimistic = useDrawingStore.getState().generations[0];

    resolveHistory([{ id: 'history-1', created_at: 1, images: [] }]);
    await historyPromise;

    expect(useDrawingStore.getState().generations.map((item) => item.id)).toEqual([
      'history-1',
      optimistic.id,
    ]);

    resolveGeneration({ ...optimistic, id: 'generation-1', status: 'succeeded' });
    await generationPromise;
  });

  it('does not let an invalidated history failure overwrite newer resource state', async () => {
    let rejectHistory: (error: Error) => void = () => {};
    invokeMock.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectHistory = reject; }));
    const { useDrawingStore } = await import('../drawingStore');

    const historyPromise = useDrawingStore.getState().ensureHistoryLoaded();
    useDrawingStore.getState().invalidateHistory('restore');
    rejectHistory(new Error('stale history failure'));

    await expect(historyPromise).rejects.toThrow('stale history failure');
    expect(useDrawingStore.getState()).toMatchObject({
      loading: false,
      error: null,
      historyMeta: { status: 'idle', revision: 1 },
    });
  });

  it('keeps the newest keyed history request when cursors resolve out of order', async () => {
    let resolveLatest: (value: unknown[]) => void = () => {};
    const latest = new Promise<unknown[]>((resolve) => { resolveLatest = resolve; });
    let resolveCursor: (value: unknown[]) => void = () => {};
    const cursor = new Promise<unknown[]>((resolve) => { resolveCursor = resolve; });
    invokeMock
      .mockReturnValueOnce(latest)
      .mockReturnValueOnce(cursor);
    const { useDrawingStore } = await import('../drawingStore');

    const first = useDrawingStore.getState().ensureHistoryLoaded();
    const second = useDrawingStore.getState().ensureHistoryLoaded({ cursor: 'older-page' });
    resolveCursor([{ id: 'older', created_at: 1, images: [] }]);
    await second;
    resolveLatest([{ id: 'latest', created_at: 2, images: [] }]);
    await Promise.all([first, second]);

    expect(useDrawingStore.getState().generations.map((item) => item.id)).toEqual(['older']);
    expect(useDrawingStore.getState().historyMeta.key).toBe('older-page');
  });

  it('keeps drawing history oldest first', async () => {
    invokeMock.mockResolvedValueOnce([
      { id: 'newer', created_at: 20, images: [] },
      { id: 'older', created_at: 10, images: [] },
    ]);
    const { useDrawingStore } = await import('../drawingStore');

    await useDrawingStore.getState().loadHistory();

    expect(useDrawingStore.getState().generations.map((item) => item.id)).toEqual(['older', 'newer']);
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
      reference_image_mode: 'multipart',
      reference_image_format: 'object',
      reference_image_param_name: 'image',
      reference_file_ids: [],
    });

    expect(invokeMock).toHaveBeenCalledWith('generate_drawing_images', {
      input: expect.objectContaining({ n: 10 }),
    });
  });

  it('does not add duplicate reference entries when the backend reuses an existing file', async () => {
    const { useDrawingStore } = await import('../drawingStore');
    const file = new File(['abc'], 'ref.png', { type: 'image/png' });
    invokeMock.mockResolvedValue({
      id: 'ref-1',
      original_name: 'ref.png',
      mime_type: 'image/png',
      size_bytes: 3,
      storage_path: 'images/ref.png',
    });

    await useDrawingStore.getState().uploadReferenceImage(file);
    await useDrawingStore.getState().uploadReferenceImage(file);

    expect(useDrawingStore.getState().references.map((item) => item.id)).toEqual(['ref-1']);
  });

  it('uses an existing generated image file as a drawing reference', async () => {
    const { useDrawingStore } = await import('../drawingStore');

    const reference = useDrawingStore.getState().useImageAsReference({
      id: 'image-1',
      generation_id: 'generation-1',
      stored_file_id: 'stored-image-1',
      storage_path: 'images/generated.png',
      mime_type: 'image/png',
      width: 1024,
      height: 1024,
      revised_prompt: null,
      created_at: 1,
    });
    useDrawingStore.getState().useImageAsReference({
      id: 'image-1',
      generation_id: 'generation-1',
      stored_file_id: 'stored-image-1',
      storage_path: 'images/generated.png',
      mime_type: 'image/png',
      width: 1024,
      height: 1024,
      revised_prompt: null,
      created_at: 1,
    });

    expect(reference).toMatchObject({
      id: 'stored-image-1',
      original_name: 'generated.png',
      mime_type: 'image/png',
      storage_path: 'images/generated.png',
    });
    expect(useDrawingStore.getState().references.map((item) => item.id)).toEqual(['stored-image-1']);
  });

  it('adds a running generation immediately while generation is pending', async () => {
    let resolveGeneration: (value: any) => void = () => {};
    invokeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const { useDrawingStore } = await import('../drawingStore');

    const promise = useDrawingStore.getState().generateImages({
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      prompt: '一只发光的机械猫',
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
      background: 'auto',
      n: 4,
      reference_image_mode: 'multipart',
      reference_image_format: 'object',
      reference_image_param_name: 'image',
      reference_file_ids: [],
    });

    const pending = useDrawingStore.getState().generations[0];
    expect(pending).toMatchObject({
      status: 'running',
      prompt: '一只发光的机械猫',
      model_id: 'gpt-image-2',
      images: [],
    });
    expect(JSON.parse(pending.parameters_json)).toMatchObject({ n: 4 });

    resolveGeneration({
      ...pending,
      id: 'generation-1',
      status: 'succeeded',
      completed_at: 1,
      images: [],
    });
    await promise;

    expect(useDrawingStore.getState().generations).toHaveLength(1);
    expect(useDrawingStore.getState().generations[0].id).toBe('generation-1');
  });

  it('marks a running optimistic generation as stopped and ignores a late backend result', async () => {
    let resolveGeneration: (value: any) => void = () => {};
    invokeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const { useDrawingStore } = await import('../drawingStore');

    const promise = useDrawingStore.getState().generateImages({
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      prompt: '可以被停止的任务',
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
      background: 'auto',
      n: 1,
      reference_image_mode: 'multipart',
      reference_image_format: 'object',
      reference_image_param_name: 'image',
      reference_file_ids: [],
    });

    const optimistic = useDrawingStore.getState().generations[0];
    useDrawingStore.getState().stopGeneration(optimistic.id);

    expect(useDrawingStore.getState().submitting).toBe(false);
    expect(useDrawingStore.getState().generations[0]).toMatchObject({
      id: optimistic.id,
      status: 'stopped',
      error_message: '主动停止',
      images: [],
    });

    resolveGeneration({
      ...optimistic,
      id: 'generation-from-backend',
      status: 'succeeded',
      completed_at: 2,
      images: [{ id: 'image-1' }],
    });
    await promise;

    expect(useDrawingStore.getState().generations).toHaveLength(1);
    expect(useDrawingStore.getState().generations[0]).toMatchObject({
      id: optimistic.id,
      status: 'stopped',
      images: [],
    });
  });

  it('keeps reference, source, and mask preview metadata on optimistic records', async () => {
    let resolveGeneration: (value: any) => void = () => {};
    invokeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const { useDrawingStore } = await import('../drawingStore');
    useDrawingStore.setState({
      references: [{
        id: 'ref-1',
        original_name: 'ref.png',
        mime_type: 'image/png',
        size_bytes: 256,
        storage_path: 'images/ref.png',
      }],
      editSourceImage: {
        id: 'source-image-1',
        generation_id: 'source-generation',
        stored_file_id: 'source-file-1',
        storage_path: 'images/source.png',
        mime_type: 'image/png',
        width: 1024,
        height: 1024,
        revised_prompt: null,
        created_at: 1,
      },
      editMaskFileId: 'mask-1',
      editMaskFile: {
        id: 'mask-1',
        original_name: 'mask.png',
        mime_type: 'image/png',
        size_bytes: 128,
        storage_path: 'images/mask.png',
      },
    });

    const promise = useDrawingStore.getState().editImageWithMask({
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      prompt: '替换涂抹区域',
      size: 'auto',
      quality: 'auto',
      output_format: 'png',
      background: 'auto',
      n: 1,
      source_image_id: 'source-image-1',
      mask_file_id: 'mask-1',
      reference_image_mode: 'multipart',
      reference_image_format: 'object',
      reference_image_param_name: 'image',
      reference_file_ids: ['ref-1'],
    });

    const pending = useDrawingStore.getState().generations[0];
    expect(pending.reference_files?.[0].id).toBe('ref-1');
    expect(pending.source_images?.[0].id).toBe('source-image-1');
    expect(pending.mask_file?.id).toBe('mask-1');

    resolveGeneration({
      ...pending,
      id: 'generation-1',
      status: 'succeeded',
      completed_at: 1,
      images: [],
    });
    await promise;
  });

  it('appends a pending generation to the bottom of existing history', async () => {
    let resolveGeneration: (value: any) => void = () => {};
    invokeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveGeneration = resolve;
    }));
    const { useDrawingStore } = await import('../drawingStore');
    useDrawingStore.setState({
      generations: [{
        id: 'older',
        created_at: 1,
        images: [],
      } as any],
    });

    const promise = useDrawingStore.getState().generateImages({
      provider_id: 'provider-1',
      model_id: 'gpt-image-2',
      prompt: '新的生成应该在底部',
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
      background: 'auto',
      n: 1,
      reference_image_mode: 'multipart',
      reference_image_format: 'object',
      reference_image_param_name: 'image',
      reference_file_ids: [],
    });

    const idsWhilePending = useDrawingStore.getState().generations.map((item) => item.id);
    expect(idsWhilePending[0]).toBe('older');
    expect(idsWhilePending[1]).toMatch(/^optimistic-/);

    resolveGeneration({
      ...useDrawingStore.getState().generations[1],
      id: 'newer',
      created_at: 2,
      status: 'succeeded',
      images: [],
    });
    await promise;

    expect(useDrawingStore.getState().generations.map((item) => item.id)).toEqual(['older', 'newer']);
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
      reference_image_mode: 'multipart',
      reference_image_format: 'object',
      reference_image_param_name: 'image',
      reference_file_ids: [],
    });

    expect(invokeMock).toHaveBeenCalledWith('edit_drawing_image_with_mask', {
      input: expect.objectContaining({
        source_image_id: 'image-1',
        mask_file_id: 'mask-1',
      }),
    });
  });

  it('uses the current reference image mode when retrying a generation', async () => {
    invokeMock.mockResolvedValueOnce({ id: 'generation-2', images: [] });
    const { useDrawingStore } = await import('../drawingStore');

    await useDrawingStore.getState().retryGeneration({
      id: 'generation-1',
      parent_generation_id: null,
      provider_id: 'provider-1',
      key_id: 'key-1',
      model_id: 'gpt-image-2',
      api_kind: 'image_api',
      action: 'reference_generate',
      prompt: '重试参考图生成',
      parameters_json: JSON.stringify({
        provider_id: 'provider-1',
        model_id: 'gpt-image-2',
        prompt: '重试参考图生成',
        size: '1024x1024',
        quality: 'auto',
        output_format: 'png',
        background: 'auto',
        n: 1,
        reference_image_mode: 'multipart',
        reference_image_format: 'object',
        reference_image_param_name: 'image',
        reference_file_ids: ['ref-1'],
      }),
      reference_file_ids_json: '["ref-1"]',
      source_image_ids_json: '[]',
      mask_file_id: null,
      status: 'failed',
      error_message: 'failed',
      response_id: null,
      usage_json: null,
      created_at: 1,
      completed_at: 2,
      images: [],
    }, 'base64');

    expect(invokeMock).toHaveBeenCalledWith('generate_drawing_images', {
      input: expect.objectContaining({
        reference_image_mode: 'base64',
        reference_image_format: 'object',
        reference_image_param_name: 'images',
        reference_file_ids: ['ref-1'],
      }),
    });
  });

  it('passes the delete resources flag to the drawing delete command', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const { useDrawingStore } = await import('../drawingStore');
    useDrawingStore.setState({
      generations: [{
        id: 'generation-1',
        created_at: 1,
        images: [],
      } as any],
    });

    await useDrawingStore.getState().deleteGeneration('generation-1', true);

    expect(invokeMock).toHaveBeenCalledWith('delete_drawing_generation', {
      id: 'generation-1',
      deleteResources: true,
    });
    expect(useDrawingStore.getState().generations).toEqual([]);
  });
});
