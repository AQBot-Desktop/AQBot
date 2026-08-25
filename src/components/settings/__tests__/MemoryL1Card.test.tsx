import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemoryStore } from '@/stores';
import { MemoryL1Card, utf8ByteLength } from '../MemoryL1Card';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) => {
      if (key === 'settings.memory.l1.byteCount') return `${args?.bytes} / ${args?.limit} bytes`;
      return key;
    },
  }),
}));

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    theme: {
      useToken: () => ({
        token: {
          colorError: 'red',
          colorTextSecondary: 'gray',
          colorBorder: '#ddd',
          borderRadius: 6,
          colorFillAlter: '#fafafa',
        },
      }),
    },
  };
});

describe('MemoryL1Card', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useMemoryStore.setState({ l1: null });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_memory_l1') {
        return { enabled: true, markdown: '', revision: 0, sortOrder: 0, updatedAt: 'now' };
      }
      if (cmd === 'save_memory_l1') {
        return { enabled: true, markdown: 'I prefer concise answers', revision: 1, sortOrder: 0, updatedAt: 'now' };
      }
      return null;
    });
  });

  it('counts UTF-8 bytes and saves with the current revision', async () => {
    render(<MemoryL1Card />);
    const textarea = await screen.findByLabelText('settings.memory.l1.ariaLabel');
    fireEvent.change(textarea, { target: { value: '你' } });
    expect(screen.getByText(`${utf8ByteLength('你')} / 5000 bytes`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'settings.memory.l1.save' }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('save_memory_l1', {
        input: { enabled: true, markdown: '你', revision: 0 },
      });
    });
  });

  it('imports a markdown file into the editor', async () => {
    render(<MemoryL1Card />);
    await screen.findByLabelText('settings.memory.l1.ariaLabel');
    const fileInput = screen.getByLabelText('settings.memory.l1.import');
    const file = new File(['# Hello'], 'notes.md', { type: 'text/markdown' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByLabelText('settings.memory.l1.ariaLabel')).toHaveValue('# Hello');
    });
  });
});
