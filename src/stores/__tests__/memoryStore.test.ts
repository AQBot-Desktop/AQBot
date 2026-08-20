import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '@/types';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

function memoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'memory-new',
    namespaceId: 'namespace-a',
    title: 'Saved memory',
    content: 'Saved memory',
    source: 'manual',
    indexStatus: 'indexing',
    updatedAt: '2026-08-20T00:00:00Z',
    ...overrides,
  };
}

describe('memoryStore saveText', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.resetModules();
  });

  it('trims content, builds a Unicode-safe title, and inserts the returned item', async () => {
    const content = `  a   b  ${'🙂'.repeat(60)}  `;
    const trimmedContent = content.trim();
    const title = `a b ${'🙂'.repeat(46)}`;
    const saved = memoryItem({ title, content: trimmedContent });
    invokeMock.mockResolvedValue(saved);
    const { useMemoryStore } = await import('../memoryStore');
    const existing = memoryItem({ id: 'memory-old' });
    useMemoryStore.setState({
      items: [existing],
      error: 'previous error',
      itemsMeta: {
        status: 'ready',
        key: 'namespace-a',
        loadedAt: 1,
        revision: 3,
      },
    });

    await expect(useMemoryStore.getState().saveText('namespace-a', content)).resolves.toEqual(saved);

    expect(invokeMock).toHaveBeenCalledWith('add_memory_item', {
      input: {
        namespaceId: 'namespace-a',
        title,
        content: trimmedContent,
        source: 'manual',
      },
    });
    expect(Array.from(title)).toHaveLength(50);
    expect(useMemoryStore.getState()).toMatchObject({
      items: [saved, existing],
      error: null,
      itemsMeta: {
        status: 'ready',
        key: 'namespace-a',
        revision: 4,
      },
    });
  });

  it('rejects blank content without invoking the backend', async () => {
    const { useMemoryStore } = await import('../memoryStore');

    await expect(useMemoryStore.getState().saveText('namespace-a', ' \n\t '))
      .rejects.toThrow('Memory content cannot be empty');

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useMemoryStore.getState().error).toBe('Error: Memory content cannot be empty');
  });

  it('stores and rethrows backend errors without changing loaded items', async () => {
    const failure = new Error('save failed');
    invokeMock.mockRejectedValue(failure);
    const { useMemoryStore } = await import('../memoryStore');
    const existing = memoryItem({ id: 'memory-old' });
    useMemoryStore.setState({
      items: [existing],
      itemsMeta: {
        status: 'ready',
        key: 'namespace-a',
        loadedAt: 1,
        revision: 2,
      },
    });

    await expect(useMemoryStore.getState().saveText('namespace-a', 'Remember this'))
      .rejects.toBe(failure);

    expect(useMemoryStore.getState()).toMatchObject({
      items: [existing],
      error: 'Error: save failed',
      itemsMeta: { revision: 2 },
    });
  });

  it('does not replace items cached for another namespace', async () => {
    const saved = memoryItem();
    invokeMock.mockResolvedValue(saved);
    const { useMemoryStore } = await import('../memoryStore');
    const otherItem = memoryItem({ id: 'memory-other', namespaceId: 'namespace-b' });
    useMemoryStore.setState({
      items: [otherItem],
      error: 'previous error',
      itemsMeta: {
        status: 'ready',
        key: 'namespace-b',
        loadedAt: 1,
        revision: 5,
      },
    });

    await useMemoryStore.getState().saveText('namespace-a', 'Remember this');

    expect(useMemoryStore.getState()).toMatchObject({
      items: [otherItem],
      error: null,
      itemsMeta: {
        key: 'namespace-b',
        revision: 5,
      },
    });
  });

  it('keeps a saved item when an older list request completes', async () => {
    let resolveOldList!: (items: MemoryItem[]) => void;
    let resolveFreshList!: (items: MemoryItem[]) => void;
    let listCallCount = 0;
    const saved = memoryItem();
    const stale = memoryItem({ id: 'memory-stale', content: 'Stale item' });
    const existing = memoryItem({ id: 'memory-existing', content: 'Existing item' });
    invokeMock.mockImplementation((command: string) => {
      if (command === 'add_memory_item') return Promise.resolve(saved);
      if (command === 'list_memory_items') {
        listCallCount += 1;
        return listCallCount === 1
          ? new Promise<MemoryItem[]>((resolve) => { resolveOldList = resolve; })
          : new Promise<MemoryItem[]>((resolve) => { resolveFreshList = resolve; });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const { useMemoryStore } = await import('../memoryStore');

    const oldLoad = useMemoryStore.getState().ensureItemsLoaded('namespace-a');
    await vi.waitFor(() => expect(listCallCount).toBe(1));
    await useMemoryStore.getState().saveText('namespace-a', 'Saved memory');

    expect(useMemoryStore.getState().items).toEqual([saved]);
    expect(useMemoryStore.getState().itemsMeta.revision).toBe(1);

    resolveOldList([stale]);
    await vi.waitFor(() => expect(listCallCount).toBe(2));
    expect(useMemoryStore.getState().items).toEqual([saved]);

    resolveFreshList([saved, existing]);
    await oldLoad;
    expect(useMemoryStore.getState()).toMatchObject({
      items: [saved, existing],
      itemsMeta: {
        status: 'ready',
        key: 'namespace-a',
        revision: 1,
      },
    });
  });
});
