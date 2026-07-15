import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentArea } from '@/components/layout/ContentArea';
import { useDrawingSettingsStore } from '@/stores/drawingSettingsStore';
import { useDrawingStore } from '@/stores/drawingStore';
import { useProviderStore } from '@/stores/providerStore';
import type { DrawingGeneration, DrawingImage } from '@/types';

vi.mock('@/pages/ChatPage', () => ({ ChatPage: () => <div>chat</div> }));
vi.mock('@/pages/KnowledgePage', () => ({ KnowledgePage: () => <div>knowledge</div> }));
vi.mock('@/pages/MemoryPage', () => ({ MemoryPage: () => <div>memory</div> }));
vi.mock('@/pages/GatewayPage', () => ({ GatewayPage: () => <div>gateway</div> }));
vi.mock('@/pages/FilesPage', () => ({ FilesPage: () => <div>files</div> }));
vi.mock('@/pages/SettingsPage', () => ({ SettingsPage: () => <div>settings</div> }));
vi.mock('@/pages/SkillsPage', () => ({ SkillsPage: () => <div>skills</div> }));
vi.mock('@/pages/RolesPage', () => ({ RolesPage: () => <div>roles</div> }));
vi.mock('@/lib/providerIcons', () => ({
  SmartProviderIcon: () => <span>provider-icon</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    theme: {
      ...actual.theme,
      useToken: () => ({
        token: {
          colorBgContainer: '#ffffff',
          colorBgElevated: '#ffffff',
          colorBgLayout: '#0f172a',
          colorBorderSecondary: '#e5e7eb',
          colorFillAlter: '#f6f8fa',
          colorFillSecondary: '#f3f4f6',
          colorPrimary: '#1677ff',
          colorPrimaryBg: '#e6f4ff',
          colorText: '#111827',
          colorTextBase: '#111827',
          colorTextSecondary: '#6b7280',
        },
      }),
    },
  };
});

function imageFixture(overrides: Partial<DrawingImage> = {}): DrawingImage {
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
    ...overrides,
  };
}

function generationFixture(id: string, createdAt: number, images: DrawingImage[] = []): DrawingGeneration {
  return {
    id,
    parent_generation_id: null,
    provider_id: 'provider-1',
    key_id: 'key-1',
    model_id: 'gpt-image-2',
    api_kind: 'image_api',
    action: 'generate',
    prompt: id,
    parameters_json: JSON.stringify({ n: 1, size: '1024x1024' }),
    reference_file_ids_json: '[]',
    source_image_ids_json: '[]',
    mask_file_id: null,
    status: 'succeeded',
    error_message: null,
    response_id: null,
    usage_json: null,
    created_at: createdAt,
    completed_at: createdAt,
    images,
  };
}

function createAnimationFrameQueue() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  const requestAnimationFrameSpy = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
  const cancelAnimationFrameSpy = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((frameId) => {
      frames.delete(frameId);
    });

  const flushNext = () => {
    const nextFrame = frames.entries().next().value;
    if (!nextFrame) return;
    const [frameId, callback] = nextFrame;
    frames.delete(frameId);
    callback(0);
  };

  return {
    flushNext,
    flushAll: () => {
      while (frames.size > 0) flushNext();
    },
    restore: () => {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    },
  };
}

describe('DrawingPage routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
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
    useDrawingSettingsStore.getState().resetSettings();
    useProviderStore.setState({
      providers: [],
      loading: false,
      error: null,
      providersMeta: { status: 'idle', key: null, loadedAt: null, revision: 0 },
      ensureProvidersLoaded: vi.fn(async () => {}),
    });
  });

  it('renders the drawing page from ContentArea', () => {
    render(<ContentArea activePage="drawing" />);

    expect(screen.queryByText('历史记录')).toBeNull();
    expect(screen.queryByText('绘画设置')).toBeNull();
    expect(screen.getByTestId('drawing-generation-list')).toBeDefined();
    expect(screen.getByTestId('drawing-composer')).toBeDefined();
    expect(screen.getAllByText('Auto').length).toBeGreaterThanOrEqual(1);
    const drawingPageRoot = screen.getByTestId('drawing-history-frame').closest('main')?.parentElement;
    expect(drawingPageRoot).toHaveStyle({ background: '#0f172a' });
    expect(screen.queryByRole('button', { name: '参考图' })).toBeNull();

    const composer = screen.getByTestId('drawing-composer');
    expect(composer.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(composer.style.border).toBe('1px solid var(--border-color)');
    expect(composer.style.borderRadius).toBe('16px');
    expect(composer.querySelector('textarea')).toHaveClass('aqbot-input-textarea');
    const historyFrame = screen.getByTestId('drawing-history-frame');
    const historyScroller = screen.getByTestId('drawing-history-scroll');
    expect(historyFrame).toHaveClass('absolute');
    expect(historyFrame).toHaveStyle({ bottom: '176px' });
    expect(historyScroller).toHaveClass('h-full');
    expect(historyScroller.style.paddingBottom).toBe('');
  });

  it('scrolls the history area to the bottom when a new generation appears', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const scrollTo = vi.fn();

    render(<ContentArea activePage="drawing" />);

    const scroller = screen.getByTestId('drawing-history-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('newer', 2),
        ],
      });
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'smooth' });
    requestAnimationFrameSpy.mockRestore();
  });

  it('does not stretch the history content wrapper when records are visible', () => {
    render(<ContentArea activePage="drawing" />);

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('正在生成的历史图', 1, []),
        ],
      });
    });

    expect(screen.getByTestId('drawing-generation-list').parentElement).not.toHaveClass('min-h-full');
  });

  it('scrolls the history area to the bottom when the latest generation receives images', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const scrollTo = vi.fn();

    render(<ContentArea activePage="drawing" />);

    const scroller = screen.getByTestId('drawing-history-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          {
            ...generationFixture('newer', 2),
            status: 'running',
            completed_at: null,
            images: [],
          },
        ],
      });
    });
    scrollTo.mockClear();
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('newer', 2, [imageFixture()]),
        ],
      });
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'smooth' });
    requestAnimationFrameSpy.mockRestore();
  });

  it('keeps scrolling to the bottom when the history content height changes', () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    vi.stubGlobal('ResizeObserver', vi.fn(function ResizeObserverMock(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    }));
    const scrollTo = vi.fn();

    render(<ContentArea activePage="drawing" />);

    const scroller = screen.getByTestId('drawing-history-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => {
      useDrawingStore.setState({
        generations: [
          {
            ...generationFixture('newer', 1),
            status: 'running',
            completed_at: null,
            images: [],
          },
        ],
      });
    });
    scrollTo.mockClear();
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1300 });

    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 1300, behavior: 'smooth' });
    requestAnimationFrameSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('scrolls to the bottom when a generation is deleted while already at the bottom', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const scrollTo = vi.fn();

    render(<ContentArea activePage="drawing" />);

    const scroller = screen.getByTestId('drawing-history-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1500 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('deleted-later', 2),
          generationFixture('latest', 3),
        ],
      });
    });
    scrollTo.mockClear();
    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('latest', 3),
        ],
      });
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    requestAnimationFrameSpy.mockRestore();
  });

  it('does not scroll to the bottom when a generation is deleted while reading the middle', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const scrollTo = vi.fn();

    render(<ContentArea activePage="drawing" />);

    const scroller = screen.getByTestId('drawing-history-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1500 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('deleted-later', 2),
          generationFixture('latest', 3),
        ],
      });
    });
    scrollTo.mockClear();
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('latest', 3),
        ],
      });
    });

    expect(scrollTo).not.toHaveBeenCalled();
    requestAnimationFrameSpy.mockRestore();
  });

  it('scrolls to the bottom when the latest generation is deleted', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const scrollTo = vi.fn();

    render(<ContentArea activePage="drawing" />);

    const scroller = screen.getByTestId('drawing-history-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1800 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('middle', 2),
          generationFixture('latest-deleted', 3),
        ],
      });
    });
    scrollTo.mockClear();
    scroller.scrollTop = 500;
    fireEvent.scroll(scroller);
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('middle', 2),
        ],
      });
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'smooth' });
    requestAnimationFrameSpy.mockRestore();
  });

  it('keeps scrolling to the bottom after latest deletion layout settles', () => {
    const animationFrames = createAnimationFrameQueue();
    const scrollTo = vi.fn();
    let scrollHeight = 1800;

    render(<ContentArea activePage="drawing" />);

    const scroller = screen.getByTestId('drawing-history-scroll');
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('middle', 2),
          generationFixture('latest-deleted', 3),
        ],
      });
    });
    animationFrames.flushAll();
    scrollTo.mockClear();
    scroller.scrollTop = 500;
    fireEvent.scroll(scroller);

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('middle', 2),
        ],
      });
    });
    animationFrames.flushNext();
    scrollHeight = 1200;
    animationFrames.flushAll();

    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'smooth' });
    animationFrames.restore();
  });

  it('scrolls to the bottom when deletion leaves too little content below the viewport', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const scrollTo = vi.fn();

    render(<ContentArea activePage="drawing" />);

    const scroller = screen.getByTestId('drawing-history-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1500 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('deleted-later', 2),
          generationFixture('latest', 3),
        ],
      });
    });
    scrollTo.mockClear();
    scroller.scrollTop = 420;
    fireEvent.scroll(scroller);
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('latest', 3),
        ],
      });
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    requestAnimationFrameSpy.mockRestore();
  });

  it('scrolls to the bottom when deletion later leaves too little content below the viewport', () => {
    const animationFrames = createAnimationFrameQueue();
    const scrollTo = vi.fn();
    let scrollHeight = 1500;

    render(<ContentArea activePage="drawing" />);

    const scroller = screen.getByTestId('drawing-history-scroll');
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('deleted-later', 2),
          generationFixture('latest', 3),
        ],
      });
    });
    animationFrames.flushAll();
    scrollTo.mockClear();
    scroller.scrollTop = 420;
    fireEvent.scroll(scroller);

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('older', 1),
          generationFixture('latest', 3),
        ],
      });
    });
    animationFrames.flushNext();
    scrollHeight = 1000;
    animationFrames.flushAll();

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    animationFrames.restore();
  });

  it('fills the composer from a clicked history prompt', () => {
    render(<ContentArea activePage="drawing" />);

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('历史提示词', 1),
        ],
      });
    });

    fireEvent.click(screen.getByRole('button', { name: '使用提示词' }));

    expect(screen.getByPlaceholderText('输入你想生成的画面')).toHaveValue('历史提示词');
  });

  it('uploads pasted images as drawing references and prevents the default paste', async () => {
    const uploadReferenceImage = vi.fn(async () => ({
      id: 'ref-1',
      original_name: 'pasted.png',
      mime_type: 'image/png',
      size_bytes: 3,
      storage_path: 'images/pasted.png',
    }));
    useDrawingStore.setState({ uploadReferenceImage });
    render(<ContentArea activePage="drawing" />);

    const textarea = screen.getByPlaceholderText('输入你想生成的画面');
    const file = new File(['png'], 'pasted.png', { type: 'image/png' });
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => file,
        }],
      },
    });
    const preventDefault = vi.spyOn(pasteEvent, 'preventDefault');

    fireEvent(textarea, pasteEvent);

    await waitFor(() => {
      expect(uploadReferenceImage).toHaveBeenCalledWith(file);
    });
    expect(preventDefault).toHaveBeenCalled();
  });

  it('does not intercept text-only paste in the drawing composer', () => {
    const uploadReferenceImage = vi.fn();
    useDrawingStore.setState({ uploadReferenceImage });
    render(<ContentArea activePage="drawing" />);

    const textarea = screen.getByPlaceholderText('输入你想生成的画面');
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: {
        items: [{
          kind: 'string',
          type: 'text/plain',
          getAsFile: () => null,
        }],
      },
    });
    const preventDefault = vi.spyOn(pasteEvent, 'preventDefault');

    fireEvent(textarea, pasteEvent);

    expect(uploadReferenceImage).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('keeps drawing settings when switching away from the drawing page and back', () => {
    const { rerender } = render(<ContentArea activePage="drawing" />);

    act(() => {
      useDrawingSettingsStore.getState().patchSettings({
        size: '2048x2048',
        quality: 'high',
        n: 4,
      });
    });

    rerender(<ContentArea activePage="chat" />);
    rerender(<ContentArea activePage="drawing" />);

    expect(screen.getByText('2048x2048')).toBeDefined();
    expect(screen.getByText('High')).toBeDefined();
    expect(screen.getByRole('spinbutton')).toHaveValue('4');
  });

  it('renders reference image transport in advanced settings with the official default', () => {
    render(<ContentArea activePage="drawing" />);

    fireEvent.click(screen.getByRole('button', { name: /高级设置/ }));

    expect(screen.getByText('参考图发送方式')).toBeDefined();
    expect(screen.getByText('Base64')).toBeDefined();

    const text = document.body.textContent ?? '';
    expect(text.indexOf('高级设置')).toBeLessThan(text.indexOf('参考图发送方式'));
  });

  it('does not clear a saved provider while providers are still loading', async () => {
    const ensureProvidersLoaded = vi.fn(() => new Promise<void>(() => {}));
    useProviderStore.setState({ providers: [], ensureProvidersLoaded });
    useDrawingSettingsStore.getState().patchSettings({ providerId: 'provider-1' });

    render(<ContentArea activePage="drawing" />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useDrawingSettingsStore.getState().settings.providerId).toBe('provider-1');
  });

  it('resizes the composer textarea by dragging the top handle upward', async () => {
    render(<ContentArea activePage="drawing" />);

    const handle = screen.getByTestId('drawing-composer-resize-handle');
    const textarea = screen.getByPlaceholderText('输入你想生成的画面');

    expect(textarea).toHaveStyle({ height: '72px' });

    act(() => {
      fireEvent.pointerDown(handle, { clientY: 500 });
    });
    act(() => {
      fireEvent.pointerMove(window, { clientY: 420 });
    });

    await waitFor(() => {
      expect(textarea).toHaveStyle({ height: '152px' });
    });

    act(() => {
      fireEvent.pointerUp(window);
    });
  });

  it('opens mask editor without entering composer edit mode until the mask is submitted', async () => {
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 107]) })),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
      putImageData: vi.fn(),
      set fillStyle(_value: string) {},
      set globalCompositeOperation(_value: string) {},
      set globalAlpha(_value: number) {},
    } as unknown as CanvasRenderingContext2D));
    const toDataUrlSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,mask-data');

    render(<ContentArea activePage="drawing" />);

    act(() => {
      useDrawingStore.setState({
        generations: [
          generationFixture('可区域编辑的历史图', 1, [imageFixture()]),
        ],
      });
    });

    fireEvent.click(screen.getByRole('button', { name: '区域编辑' }));

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getAllByText('区域编辑').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('编辑模式')).toBeNull();
    expect(screen.queryByText('区域编辑模式')).toBeNull();
    expect(useDrawingStore.getState().editSourceImage).toBeNull();
    expect(useDrawingStore.getState().editMaskFileId).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '提交区域编辑' }));

    await waitFor(() => {
      expect(screen.getByText('区域编辑模式')).toBeDefined();
    });
    expect(useDrawingStore.getState().editSourceImage?.id).toBe('image-1');
    expect(useDrawingStore.getState().editMaskFileId).toBeTruthy();
    expect(
      useDrawingStore.getState().editPreviewUrl === null
        || useDrawingStore.getState().editPreviewUrl?.startsWith('data:'),
    ).toBe(true);

    getContextSpy.mockRestore();
    toDataUrlSpy.mockRestore();
  });
});
