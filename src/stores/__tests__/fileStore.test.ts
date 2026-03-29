import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRow } from '@/types';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  listen: vi.fn(),
  isTauri: () => false,
}));

function makeRow(id: string, overrides: Partial<FileRow> = {}): FileRow {
  return {
    id,
    name: `file-${id}`,
    path: `/files/file-${id}`,
    missing: false,
    ...overrides,
  };
}

describe('fileStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const { useFileStore } = await import('../fileStore');
    useFileStore.setState({
      rows: [],
      loading: false,
      error: null,
      search: '',
      sortKey: 'createdAt',
    });
  });

  // ── loadCategory ──────────────────────────────────────────────────────────

  describe('loadCategory', () => {
    it('requests the correct category from the backend', async () => {
      invokeMock.mockResolvedValueOnce([]);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');

      expect(invokeMock).toHaveBeenCalledWith(
        'list_files_page_entries',
        expect.objectContaining({ category: 'images' }),
      );
    });

    it('search is scoped to the active category — passes current search text in request', async () => {
      invokeMock.mockResolvedValueOnce([]);
      const { useFileStore } = await import('../fileStore');

      useFileStore.setState({ search: 'sunset' });
      await useFileStore.getState().loadCategory('images');

      expect(invokeMock).toHaveBeenCalledWith(
        'list_files_page_entries',
        expect.objectContaining({ category: 'images', search: 'sunset' }),
      );
    });

    it('omits the search key when search text is empty', async () => {
      invokeMock.mockResolvedValueOnce([]);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('files');

      const callArgs = invokeMock.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('search');
    });

    it('missing-file rows remain in results', async () => {
      const rows = [makeRow('1'), makeRow('2', { missing: true })];
      invokeMock.mockResolvedValueOnce(rows);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');

      expect(useFileStore.getState().rows).toHaveLength(2);
      expect(useFileStore.getState().rows.find((r) => r.id === '2')?.missing).toBe(true);
    });

    it('normalizes real files-page backend entries into frontend rows', async () => {
      invokeMock.mockResolvedValueOnce([
        {
          id: 'attachment::img-1',
          sourceKind: 'attachment',
          category: 'images',
          displayName: 'screen.png',
          path: 'conv-1/screen.png',
          sizeBytes: 2048,
          createdAt: '2026-03-24T08:00:00Z',
          missing: false,
          previewUrl: 'file:///tmp/screen.png',
        },
      ]);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');

      expect(useFileStore.getState().rows).toEqual([
        expect.objectContaining({
          id: 'attachment::img-1',
          category: 'images',
          name: 'screen.png',
          path: 'conv-1/screen.png',
          size: 2048,
          createdAt: '2026-03-24T08:00:00Z',
          hasThumbnail: true,
        }),
      ]);
    });
  });

  // ── openEntry ─────────────────────────────────────────────────────────────

  describe('openEntry', () => {
    it('dispatches open command for a row that still exists (not missing)', async () => {
      invokeMock
        .mockResolvedValueOnce([makeRow('1', { path: '/img/a.jpg' })])
        .mockResolvedValueOnce(undefined);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');
      await useFileStore.getState().openEntry('/img/a.jpg');

      expect(invokeMock).toHaveBeenCalledWith('open_files_page_entry', { path: '/img/a.jpg' });
    });

    it('does NOT dispatch open command for a missing row', async () => {
      invokeMock.mockResolvedValueOnce([makeRow('1', { path: '/img/a.jpg', missing: true })]);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');
      await useFileStore.getState().openEntry('/img/a.jpg');

      expect(invokeMock).not.toHaveBeenCalledWith('open_files_page_entry', expect.anything());
    });
  });

  // ── revealEntry ───────────────────────────────────────────────────────────

  describe('revealEntry', () => {
    it('dispatches reveal command for a row that still exists (not missing)', async () => {
      invokeMock
        .mockResolvedValueOnce([makeRow('1', { path: '/img/a.jpg' })])
        .mockResolvedValueOnce(undefined);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');
      await useFileStore.getState().revealEntry('/img/a.jpg');

      expect(invokeMock).toHaveBeenCalledWith('reveal_files_page_entry', { path: '/img/a.jpg' });
    });

    it('does NOT dispatch reveal command for a missing row', async () => {
      invokeMock.mockResolvedValueOnce([makeRow('1', { path: '/img/a.jpg', missing: true })]);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');
      await useFileStore.getState().revealEntry('/img/a.jpg');

      expect(invokeMock).not.toHaveBeenCalledWith('reveal_files_page_entry', expect.anything());
    });
  });

  // ── cleanupMissingEntry ───────────────────────────────────────────────────

  describe('cleanupMissingEntry', () => {
    it('dispatches cleanup command only for rows marked missing', async () => {
      invokeMock
        .mockResolvedValueOnce([makeRow('1', { missing: true })])
        .mockResolvedValueOnce(undefined);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');
      await useFileStore.getState().cleanupMissingEntry('1');

      expect(invokeMock).toHaveBeenCalledWith('cleanup_missing_files_page_entry', { entryId: '1' });
    });

    it('does NOT dispatch cleanup command for a non-missing row', async () => {
      invokeMock.mockResolvedValueOnce([makeRow('1', { missing: false })]);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');
      await useFileStore.getState().cleanupMissingEntry('1');

      expect(invokeMock).not.toHaveBeenCalledWith(
        'cleanup_missing_files_page_entry',
        expect.anything(),
      );
    });

    it('removes the cleaned-up row from the list', async () => {
      invokeMock
        .mockResolvedValueOnce([makeRow('1', { missing: true }), makeRow('2')])
        .mockResolvedValueOnce(undefined);
      const { useFileStore } = await import('../fileStore');

      await useFileStore.getState().loadCategory('images');
      await useFileStore.getState().cleanupMissingEntry('1');

      expect(useFileStore.getState().rows.find((r) => r.id === '1')).toBeUndefined();
      expect(useFileStore.getState().rows.find((r) => r.id === '2')).toBeDefined();
    });
  });
});
