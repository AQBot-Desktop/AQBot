import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentArea } from '@/components/layout/ContentArea';
import { useDrawingStore } from '@/stores/drawingStore';
import type { DrawingGeneration, DrawingImage } from '@/types';

vi.mock('@/pages/ChatPage', () => ({ ChatPage: () => <div>chat</div> }));
vi.mock('@/pages/KnowledgePage', () => ({ KnowledgePage: () => <div>knowledge</div> }));
vi.mock('@/pages/MemoryPage', () => ({ MemoryPage: () => <div>memory</div> }));
vi.mock('@/pages/GatewayPage', () => ({ GatewayPage: () => <div>gateway</div> }));
vi.mock('@/pages/FilesPage', () => ({ FilesPage: () => <div>files</div> }));
vi.mock('@/pages/SettingsPage', () => ({ SettingsPage: () => <div>settings</div> }));
vi.mock('@/pages/SkillsPage', () => ({ SkillsPage: () => <div>skills</div> }));
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

describe('DrawingPage routing', () => {
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
  });

  it('renders the drawing page from ContentArea', () => {
    const { container } = render(<ContentArea activePage="drawing" />);

    expect(screen.queryByText('历史记录')).toBeNull();
    expect(screen.queryByText('绘画设置')).toBeNull();
    expect(screen.getByTestId('drawing-generation-list')).toBeDefined();
    expect(screen.getByTestId('drawing-composer')).toBeDefined();
    expect(screen.getAllByText('Auto').length).toBeGreaterThanOrEqual(1);
    expect(container.firstElementChild).toHaveStyle({ background: '#0f172a' });
    expect(screen.queryByRole('button', { name: '参考图' })).toBeNull();

    const composer = screen.getByTestId('drawing-composer');
    expect(composer.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(composer.style.border).toBe('1px solid var(--border-color)');
    expect(composer.style.borderRadius).toBe('16px');
    expect(composer.querySelector('textarea')).toHaveClass('aqbot-input-textarea');
    expect(screen.getByTestId('drawing-history-scroll')).toHaveStyle({ paddingBottom: '192px' });
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
