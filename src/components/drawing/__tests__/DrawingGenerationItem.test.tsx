import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrawingGeneration } from '@/types';
import { DrawingGenerationItem } from '../DrawingGenerationItem';

const invokeMock = vi.hoisted(() => vi.fn());
const copyChatImageMock = vi.hoisted(() => vi.fn());
const saveChatImageMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

vi.mock('@/lib/chatImageActions', () => ({
  copyChatImage: copyChatImageMock,
  saveChatImage: saveChatImageMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/components/common/CopyButton', () => ({
  CopyButton: ({ className, text }: { className?: string; text: string }) => (
    <button type="button" className={className} data-copy-text={text}>copy-button</button>
  ),
}));

function generationFixture(overrides: Partial<DrawingGeneration>): DrawingGeneration {
  return {
    id: 'generation-1',
    parent_generation_id: null,
    provider_id: 'provider-1',
    key_id: 'key-1',
    model_id: 'gpt-image-2',
    api_kind: 'image_api',
    action: 'generate',
    prompt: '测试提示词',
    parameters_json: JSON.stringify({ n: 3, size: '1024x1024' }),
    reference_file_ids_json: '[]',
    source_image_ids_json: '[]',
    mask_file_id: null,
    status: 'running',
    error_message: null,
    response_id: null,
    usage_json: null,
    created_at: 1,
    completed_at: null,
    images: [],
    ...overrides,
  };
}

describe('DrawingGenerationItem', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue('data:image/png;base64,abc');
    copyChatImageMock.mockReset();
    copyChatImageMock.mockResolvedValue(undefined);
    saveChatImageMock.mockReset();
    saveChatImageMock.mockResolvedValue(true);
  });

  it('renders one shimmer placeholder per requested image while running', () => {
    const { container } = render(
      <DrawingGenerationItem
        generation={generationFixture({ parameters_json: JSON.stringify({ n: 3, size: '1024x1024' }) })}
        onEdit={() => {}}
        onMaskEdit={() => {}}
        onRetry={() => {}}
        onDelete={() => {}}
        onUsePrompt={() => {}}
      />,
    );

    expect(container.querySelectorAll('.drawing-image-placeholder')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: '再次生成' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });

  it('renders source, mask, and reference thumbnails before the prompt', async () => {
    render(
      <DrawingGenerationItem
        generation={generationFixture({
          status: 'succeeded',
          source_images: [{
            id: 'source-image-1',
            generation_id: 'source-generation',
            stored_file_id: 'source-file-1',
            storage_path: 'images/source.png',
            mime_type: 'image/png',
            width: 1024,
            height: 1024,
            revised_prompt: null,
            created_at: 1,
          }],
          mask_file: {
            id: 'mask-file-1',
            original_name: 'mask.png',
            mime_type: 'image/png',
            size_bytes: 128,
            storage_path: 'images/mask.png',
          },
          reference_files: [{
            id: 'ref-file-1',
            original_name: 'ref.png',
            mime_type: 'image/png',
            size_bytes: 256,
            storage_path: 'images/ref.png',
          }],
          images: [{
            id: 'image-1',
            generation_id: 'generation-1',
            stored_file_id: 'file-1',
            storage_path: 'images/drawing.png',
            mime_type: 'image/png',
            width: 1024,
            height: 1024,
            revised_prompt: null,
            created_at: 1,
          }],
        })}
        onEdit={() => {}}
        onMaskEdit={() => {}}
        onRetry={() => {}}
        onDelete={() => {}}
        onUsePrompt={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByAltText('原图 1')).toBeDefined();
      expect(screen.getByAltText('Mask 图')).toBeDefined();
      expect(screen.getByAltText('参考图 1')).toBeDefined();
    });
    expect(invokeMock).toHaveBeenCalledWith('read_attachment_preview', { filePath: 'images/source.png' });
    expect(invokeMock).toHaveBeenCalledWith('read_attachment_preview', { filePath: 'images/mask.png' });
    expect(invokeMock).toHaveBeenCalledWith('read_attachment_preview', { filePath: 'images/ref.png' });
  });

  it('fills the composer prompt when the prompt text is clicked and exposes CopyButton', () => {
    const onUsePrompt = vi.fn();
    render(
      <DrawingGenerationItem
        generation={generationFixture({ prompt: '点击复制这个提示词' })}
        onEdit={() => {}}
        onMaskEdit={() => {}}
        onRetry={() => {}}
        onDelete={() => {}}
        onUsePrompt={onUsePrompt}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '使用提示词' }));

    expect(onUsePrompt).toHaveBeenCalledWith('点击复制这个提示词');
    expect(document.querySelector('.drawing-prompt-copy')).toHaveAttribute('data-copy-text', '点击复制这个提示词');
    expect(document.querySelector('.drawing-prompt-trigger .drawing-prompt-copy')).toBeNull();
    expect(document.querySelector('.drawing-prompt-inline')).toBeNull();
  });

  it('renders generation parameters as structured metadata chips', () => {
    render(
      <DrawingGenerationItem
        generation={generationFixture({
          parameters_json: JSON.stringify({
            n: 4,
            size: '1024x1024',
            quality: 'auto',
            output_format: 'png',
            background: 'auto',
          }),
        })}
        onEdit={() => {}}
        onMaskEdit={() => {}}
        onRetry={() => {}}
        onDelete={() => {}}
        onUsePrompt={() => {}}
      />,
    );

    expect(screen.getByText('模型')).toBeDefined();
    expect(screen.getByText('gpt-image-2')).toBeDefined();
    expect(screen.getByText('尺寸')).toBeDefined();
    expect(screen.getByText('1:1 | 1K')).toBeDefined();
    expect(screen.getByText('质量')).toBeDefined();
    expect(screen.getAllByText('自动').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('格式')).toBeDefined();
    expect(screen.getByText('PNG')).toBeDefined();
    expect(screen.getByText('张数')).toBeDefined();
    expect(screen.getByText('4')).toBeDefined();
  });

  it('localizes the automatic size value in generation metadata', () => {
    render(
      <DrawingGenerationItem
        generation={generationFixture({
          parameters_json: JSON.stringify({
            n: 1,
            size: 'auto',
            quality: 'auto',
            output_format: 'png',
            background: 'auto',
          }),
        })}
        onEdit={() => {}}
        onMaskEdit={() => {}}
        onRetry={() => {}}
        onDelete={() => {}}
        onUsePrompt={() => {}}
      />,
    );

    expect(screen.getByText('尺寸')).toBeDefined();
    expect(screen.getAllByText('自动').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('auto')).toBeNull();
  });

  it('shows failed generation errors with a copy action', () => {
    render(
      <DrawingGenerationItem
        generation={generationFixture({
          status: 'failed',
          error_message: 'OpenAI image API error 400',
        })}
        onEdit={() => {}}
        onMaskEdit={() => {}}
        onRetry={() => {}}
        onDelete={() => {}}
        onUsePrompt={() => {}}
      />,
    );

    expect(screen.getByText('OpenAI image API error 400')).toBeDefined();
    expect(screen.getAllByText('copy-button').length).toBeGreaterThanOrEqual(1);
  });

  it('renders small icon-only filled action buttons and exposes both delete modes from the delete dropdown', async () => {
    const onDelete = vi.fn();
    const { container } = render(
      <DrawingGenerationItem
        generation={generationFixture({
          status: 'succeeded',
          images: [{
            id: 'image-1',
            generation_id: 'generation-1',
            stored_file_id: 'file-1',
            storage_path: 'images/drawing.png',
            mime_type: 'image/png',
            width: 1024,
            height: 1024,
            revised_prompt: null,
            created_at: 1,
          }],
        })}
        onEdit={() => {}}
        onMaskEdit={() => {}}
        onRetry={() => {}}
        onDelete={onDelete}
        onUsePrompt={() => {}}
      />,
    );

    const actionButtons = Array.from(container.querySelectorAll('.mt-4 .ant-btn'));
    expect(container.querySelectorAll('.mt-4 .ant-btn-variant-filled').length).toBeGreaterThanOrEqual(5);
    expect(container.querySelectorAll('.mt-4 .ant-btn-sm').length).toBeGreaterThanOrEqual(5);
    expect(actionButtons.every((button) => button.textContent === '')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(await screen.findByText('仅删除记录'));
    expect(onDelete).toHaveBeenCalledWith('generation-1', false);

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(await screen.findByText('全部删除'));
    expect(onDelete).toHaveBeenCalledWith('generation-1', true);
  });

  it('moves image actions to the bottom download dropdown', async () => {
    render(
      <DrawingGenerationItem
        generation={generationFixture({
          status: 'succeeded',
          images: [{
            id: 'image-1',
            generation_id: 'generation-1',
            stored_file_id: 'file-1',
            storage_path: 'images/drawing.png',
            mime_type: 'image/png',
            width: 1024,
            height: 1024,
            revised_prompt: null,
            created_at: 1,
          }],
        })}
        onEdit={() => {}}
        onMaskEdit={() => {}}
        onRetry={() => {}}
        onDelete={() => {}}
        onUsePrompt={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    fireEvent.click(await screen.findByText('打开原图目录'));
    expect(invokeMock).toHaveBeenCalledWith('reveal_attachment_file', { filePath: 'images/drawing.png' });

    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    fireEvent.click(await screen.findByText('另存为'));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('read_attachment_preview', { filePath: 'images/drawing.png' }));
    await waitFor(() => expect(saveChatImageMock).toHaveBeenCalledWith('data:image/png;base64,abc', 'drawing.png'));

    fireEvent.click(screen.getByRole('button', { name: '下载' }));
    fireEvent.click(await screen.findByText('复制到剪切板'));
    await waitFor(() => expect(copyChatImageMock).toHaveBeenCalledWith('data:image/png;base64,abc'));
  });
});
