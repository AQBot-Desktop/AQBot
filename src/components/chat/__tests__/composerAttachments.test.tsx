import { Activity } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fileToAttachmentInput,
  getAttachmentMimeType,
  isAllowedAcpAttachmentFile,
  isAllowedChatAttachmentFile,
  useComposerAttachments,
} from '../composerAttachments';

const tauriMocks = vi.hoisted(() => ({
  onDragDropEvent: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: tauriMocks.onDragDropEvent }),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: tauriMocks.readFile,
  stat: tauriMocks.stat,
}));

function ActivityAttachmentProbe() {
  const composer = useComposerAttachments({ acceptFile: () => true });
  return (
    <>
      <button
        type="button"
        onClick={() => composer.addFiles([
          new File(['image'], 'activity.png', { type: 'image/png' }),
        ])}
      >
        add
      </button>
      <output aria-label="attachment-count">{composer.attachments.length}</output>
    </>
  );
}

describe('composerAttachments', () => {
  beforeEach(() => {
    tauriMocks.onDragDropEvent.mockReset();
    tauriMocks.readFile.mockReset();
    tauriMocks.stat.mockReset();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('infers common MIME types when browsers omit or generalize them', () => {
    expect(getAttachmentMimeType('diagram.PNG', '')).toBe('image/png');
    expect(getAttachmentMimeType('notes.md', 'application/octet-stream')).toBe('text/markdown');
    expect(getAttachmentMimeType('photo.HEIC', '')).toBe('image/heic');
    expect(getAttachmentMimeType('photo.avif', '')).toBe('image/avif');
    expect(getAttachmentMimeType('archive.unknown', '')).toBe('application/octet-stream');
    expect(getAttachmentMimeType('custom.data', 'application/x-custom')).toBe('application/x-custom');
    expect(getAttachmentMimeType('photo.PNG', 'application/x-custom')).toBe('image/png');
    expect(getAttachmentMimeType('payload.bin', 'IMAGE/WEBP')).toBe('image/webp');
  });

  it('keeps Chat image and document policies independent', () => {
    const image = new File(['image'], 'photo.png', { type: 'image/png' });
    const document = new File(['text'], 'notes.md', { type: '' });
    const archive = new File(['zip'], 'bundle.zip', { type: 'application/zip' });

    expect(isAllowedChatAttachmentFile(image, true, false)).toBe(true);
    expect(isAllowedChatAttachmentFile(image, false, true)).toBe(false);
    expect(isAllowedChatAttachmentFile(document, false, true)).toBe(true);
    expect(isAllowedChatAttachmentFile(document, false, false)).toBe(false);
    expect(isAllowedChatAttachmentFile(archive, true, true)).toBe(false);
  });

  it('allows every ACP file except images when the agent lacks image capability', () => {
    const imageWithoutMime = new File(['image'], 'photo.webp');
    const modernImageWithoutMime = new File(['image'], 'photo.heic');
    const imageWithWrongMime = new File(['image'], 'photo.png', {
      type: 'application/x-custom',
    });
    const archive = new File(['zip'], 'bundle.zip', { type: 'application/zip' });

    expect(isAllowedAcpAttachmentFile(imageWithoutMime, false)).toBe(false);
    expect(isAllowedAcpAttachmentFile(imageWithoutMime, true)).toBe(true);
    expect(isAllowedAcpAttachmentFile(modernImageWithoutMime, false)).toBe(false);
    expect(isAllowedAcpAttachmentFile(imageWithWrongMime, false)).toBe(false);
    expect(isAllowedAcpAttachmentFile(imageWithWrongMime, true)).toBe(true);
    expect(isAllowedAcpAttachmentFile(archive, false)).toBe(true);
  });

  it('encodes a selected file as an AttachmentInput', async () => {
    const file = new File(['hello'], 'README.md', { type: '' });

    await expect(fileToAttachmentInput(file)).resolves.toEqual({
      file_name: 'README.md',
      file_type: 'text/markdown',
      file_size: 5,
      data: 'aGVsbG8=',
    });
    await expect(fileToAttachmentInput(new File(['P'], 'photo.PNG', {
      type: 'application/x-custom',
    }))).resolves.toMatchObject({
      file_name: 'photo.PNG',
      file_type: 'image/png',
    });
  });

  it('deduplicates files and revokes a removed image preview', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image-preview');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useComposerAttachments({
      acceptFile: () => true,
    }));
    const image = new File(['image'], 'photo.png', {
      type: 'image/png',
      lastModified: 123,
    });

    act(() => result.current.addFiles([image, image]));
    expect(result.current.attachments).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledOnce();

    act(() => result.current.removeAttachment(result.current.attachments[0].id));
    expect(result.current.attachments).toEqual([]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image-preview');

    unmount();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('reports rejected files without adding them', () => {
    const onRejected = vi.fn();
    const { result } = renderHook(() => useComposerAttachments({
      acceptFile: (file) => !file.type.startsWith('image/'),
      onRejected,
    }));
    const image = new File(['image'], 'photo.png', { type: 'image/png' });
    const document = new File(['text'], 'notes.txt', { type: 'text/plain' });

    act(() => result.current.addFiles([image, document]));

    expect(result.current.attachments.map(({ file }) => file.name)).toEqual(['notes.txt']);
    expect(onRejected).toHaveBeenCalledWith([image]);
  });

  it('adds clipboard files and prevents the textarea default paste', () => {
    const { result } = renderHook(() => useComposerAttachments({
      acceptFile: () => true,
    }));
    const document = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    const preventDefault = vi.fn();
    const event = {
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => document }],
      },
      preventDefault,
    } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;

    act(() => {
      expect(result.current.handleClipboardFiles(event)).toBe(true);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.current.attachments.map(({ file }) => file.name)).toEqual(['notes.txt']);
  });

  it('consumes rejected clipboard files after reporting them', () => {
    const onRejected = vi.fn();
    const { result } = renderHook(() => useComposerAttachments({
      acceptFile: () => false,
      onRejected,
    }));
    const image = new File(['image'], 'photo.png', { type: 'image/png' });
    const preventDefault = vi.fn();
    const event = {
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => image }],
      },
      preventDefault,
    } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;

    act(() => {
      expect(result.current.handleClipboardFiles(event)).toBe(true);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onRejected).toHaveBeenCalledWith([image]);
    expect(result.current.attachments).toEqual([]);
  });

  it('uses the HTML drag fallback to show the overlay and add dropped files', () => {
    const { result } = renderHook(() => useComposerAttachments({
      acceptFile: () => true,
    }));
    const archive = new File(['zip'], 'bundle.zip', { type: 'application/zip' });
    const dataTransfer = {
      types: ['Files'],
      files: [archive],
      dropEffect: 'none',
    };
    const event = {
      dataTransfer,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.DragEvent;

    act(() => result.current.dragHandlers.onDragEnter(event));
    expect(result.current.isDragging).toBe(true);

    act(() => result.current.dragHandlers.onDrop(event));
    expect(result.current.isDragging).toBe(false);
    expect(result.current.attachments.map(({ file }) => file.name)).toEqual(['bundle.zip']);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('reads dropped files from dataTransfer items when the FileList is empty', () => {
    const { result } = renderHook(() => useComposerAttachments({
      acceptFile: () => true,
    }));
    const document = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    const event = {
      dataTransfer: {
        types: ['Files'],
        files: [],
        items: [{ kind: 'file', getAsFile: () => document }],
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.DragEvent;

    act(() => result.current.dragHandlers.onDrop(event));

    expect(result.current.attachments.map(({ file }) => file.name)).toEqual(['notes.txt']);
  });

  it('accepts a window-level drop while the overlay is visible', () => {
    const { result } = renderHook(() => useComposerAttachments({
      acceptFile: () => true,
    }));
    const enterEvent = {
      dataTransfer: { types: ['Files'] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.DragEvent;
    const image = new File(['image'], 'photo.png', { type: 'image/png' });

    act(() => result.current.dragHandlers.onDragEnter(enterEvent));
    expect(result.current.isDragging).toBe(true);

    act(() => {
      const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { types: ['Files'], files: [image], items: [] },
      });
      window.dispatchEvent(dropEvent);
    });

    expect(result.current.isDragging).toBe(false);
    expect(result.current.attachments.map(({ file }) => file.name)).toEqual(['photo.png']);
  });

  it('does not throw when a drop has no dataTransfer', () => {
    const { result } = renderHook(() => useComposerAttachments({
      acceptFile: () => true,
    }));
    const event = {
      dataTransfer: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.DragEvent;

    act(() => result.current.dragHandlers.onDrop(event));

    expect(result.current.attachments).toEqual([]);
    expect(result.current.isDragging).toBe(false);
  });

  it('keeps the HTML drag overlay until the outermost drag leave', () => {
    const { result } = renderHook(() => useComposerAttachments({ acceptFile: () => true }));
    const event = {
      dataTransfer: { types: ['Files'] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.DragEvent;

    act(() => {
      result.current.dragHandlers.onDragEnter(event);
      result.current.dragHandlers.onDragEnter(event);
      result.current.dragHandlers.onDragLeave(event);
    });
    expect(result.current.isDragging).toBe(true);

    act(() => result.current.dragHandlers.onDragLeave(event));
    expect(result.current.isDragging).toBe(false);
  });

  it('clears attachment state and preview URLs when an Activity page suspends', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:activity');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const renderProbe = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <ActivityAttachmentProbe />
      </Activity>
    );
    const view = render(renderProbe('visible'));
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(screen.getByLabelText('attachment-count')).toHaveTextContent('1');

    view.rerender(renderProbe('hidden'));
    view.rerender(renderProbe('visible'));

    expect(screen.getByLabelText('attachment-count')).toHaveTextContent('0');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:activity');
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('reads files from Tauri native drop events', async () => {
    let listener: ((event: { payload: { type: string; paths?: string[] } }) => Promise<void>)
      | undefined;
    const unlisten = vi.fn();
    tauriMocks.onDragDropEvent.mockImplementation(async (nextListener) => {
      listener = nextListener;
      return unlisten;
    });
    tauriMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    tauriMocks.stat.mockResolvedValue({ mtime: new Date(123), size: 3 });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    const acceptFile = () => true;
    const { result, unmount } = renderHook(() => useComposerAttachments({
      acceptFile,
    }));

    await waitFor(() => expect(listener).toBeDefined());
    await act(async () => {
      await listener?.({
        payload: { type: 'drop', paths: ['/tmp/native-notes.md'] },
      });
    });

    expect(tauriMocks.readFile).toHaveBeenCalledWith('/tmp/native-notes.md');
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].file.name).toBe('native-notes.md');
    expect(result.current.attachments[0].file.type).toBe('text/markdown');
    expect(result.current.attachments[0].file.lastModified).toBe(123);

    act(() => result.current.addFiles([
      new File([new Uint8Array([1, 2, 3])], 'native-notes.md', {
        type: 'text/markdown',
        lastModified: 456,
      }),
    ]));
    expect(result.current.attachments).toHaveLength(1);

    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('still attaches a native drop when stat is unavailable', async () => {
    let listener: ((event: { payload: { type: string; paths?: string[] } }) => Promise<void>)
      | undefined;
    tauriMocks.onDragDropEvent.mockImplementation(async (nextListener) => {
      listener = nextListener;
      return vi.fn();
    });
    tauriMocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    tauriMocks.stat.mockRejectedValue(new Error('stat not allowed'));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    const { result, unmount } = renderHook(() => useComposerAttachments({
      acceptFile: () => true,
    }));

    await waitFor(() => expect(listener).toBeDefined());
    await act(async () => {
      await listener?.({
        payload: { type: 'drop', paths: ['/tmp/photo.png'] },
      });
    });

    expect(tauriMocks.readFile).toHaveBeenCalledWith('/tmp/photo.png');
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].file.name).toBe('photo.png');
    expect(result.current.attachments[0].file.type).toBe('image/png');
    unmount();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('does not report native listener setup failures as attachment read failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let rejectSetup: ((error: Error) => void) | undefined;
    tauriMocks.onDragDropEvent.mockImplementation(() => new Promise((_, reject) => {
      rejectSetup = reject;
    }));
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    const onReadError = vi.fn();
    const { unmount } = renderHook(() => useComposerAttachments({
      acceptFile: () => true,
      onReadError,
    }));

    await waitFor(() => expect(rejectSetup).toBeDefined());
    const setupError = new Error('native listener setup failed');
    await act(async () => {
      rejectSetup?.(setupError);
      await Promise.resolve();
    });

    expect(onReadError).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[composer attachments] Failed to register native drag-and-drop listener:',
      setupError,
    );
    unmount();
    consoleError.mockRestore();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('does not register a native listener after setup is superseded', async () => {
    const unlisten = vi.fn();
    tauriMocks.onDragDropEvent.mockResolvedValue(unlisten);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useComposerAttachments({
        acceptFile: () => true,
        enabled,
      }),
      { initialProps: { enabled: true } },
    );
    rerender({ enabled: false });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tauriMocks.onDragDropEvent).not.toHaveBeenCalled();
    unmount();
    expect(unlisten).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('reports native file read failures with the concrete path', async () => {
    let listener: ((event: { payload: { type: string; paths: string[] } }) => Promise<void>)
      | undefined;
    tauriMocks.onDragDropEvent.mockImplementation(async (nextListener) => {
      listener = nextListener;
      return vi.fn();
    });
    const readError = new Error('native file read failed');
    tauriMocks.readFile.mockRejectedValue(readError);
    tauriMocks.stat.mockResolvedValue({ mtime: null, size: 0 });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    const onReadError = vi.fn();
    const { unmount } = renderHook(() => useComposerAttachments({
      acceptFile: () => true,
      onReadError,
    }));

    await waitFor(() => expect(listener).toBeDefined());
    await act(async () => {
      await listener?.({ payload: { type: 'drop', paths: ['/tmp/broken.md'] } });
    });

    expect(onReadError).toHaveBeenCalledWith('/tmp/broken.md', readError);
    unmount();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('keeps one native listener when attachment policy callbacks change', async () => {
    let listener: ((event: { payload: { type: string; paths: string[] } }) => Promise<void>)
      | undefined;
    const unlisten = vi.fn();
    tauriMocks.onDragDropEvent.mockImplementation(async (nextListener) => {
      listener = nextListener;
      return unlisten;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    const initialOnRejected = vi.fn();
    const latestOnRejected = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ acceptFile, onReadError, onRejected }) => useComposerAttachments({
        acceptFile,
        onReadError,
        onRejected,
      }),
      {
        initialProps: {
          acceptFile: (_file: File) => true,
          onReadError: (_filePath: string, _error: unknown) => undefined,
          onRejected: initialOnRejected,
        },
      },
    );

    await waitFor(() => expect(listener).toBeDefined());
    rerender({
      acceptFile: (_file: File) => false,
      onReadError: (_filePath: string, _error: unknown) => undefined,
      onRejected: latestOnRejected,
    });
    await act(async () => {
      await listener?.({ payload: { type: 'drop', paths: ['/tmp/rejected.txt'] } });
    });

    expect(unlisten).not.toHaveBeenCalled();
    expect(tauriMocks.onDragDropEvent).toHaveBeenCalledOnce();
    expect(initialOnRejected).not.toHaveBeenCalled();
    expect(latestOnRejected).toHaveBeenCalledOnce();
    expect(tauriMocks.readFile).not.toHaveBeenCalled();
    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('rejects a native image path before reading it when image input is unavailable', async () => {
    let listener: ((event: { payload: { type: string; paths: string[] } }) => Promise<void>)
      | undefined;
    tauriMocks.onDragDropEvent.mockImplementation(async (nextListener) => {
      listener = nextListener;
      return vi.fn();
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    const onRejected = vi.fn();
    const { unmount } = renderHook(() => useComposerAttachments({
      acceptFile: (file) => isAllowedAcpAttachmentFile(file, false),
      onRejected,
    }));

    await waitFor(() => expect(listener).toBeDefined());
    await act(async () => {
      await listener?.({ payload: { type: 'drop', paths: ['/tmp/large-photo.HEIC'] } });
    });

    expect(onRejected).toHaveBeenCalledOnce();
    expect(tauriMocks.readFile).not.toHaveBeenCalled();
    expect(tauriMocks.stat).not.toHaveBeenCalled();
    unmount();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });
});
