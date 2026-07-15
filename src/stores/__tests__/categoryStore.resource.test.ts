import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

describe('categoryStore resource loading', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.resetModules();
  });

  it('coalesces concurrent requests and treats an empty result as loaded', async () => {
    let resolve!: (value: unknown[]) => void;
    invokeMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { useCategoryStore } = await import('../categoryStore');

    const first = useCategoryStore.getState().ensureCategoriesLoaded();
    const second = useCategoryStore.getState().ensureCategoriesLoaded();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    resolve([]);
    await Promise.all([first, second]);
    await useCategoryStore.getState().ensureCategoriesLoaded();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useCategoryStore.getState().categoriesMeta.status).toBe('ready');
  });

  it('ignores an in-flight result after explicit invalidation', async () => {
    let resolveStale!: (value: unknown[]) => void;
    invokeMock
      .mockReturnValueOnce(new Promise((done) => { resolveStale = done; }))
      .mockResolvedValueOnce([]);
    const { useCategoryStore } = await import('../categoryStore');

    const staleLoad = useCategoryStore.getState().ensureCategoriesLoaded();
    useCategoryStore.getState().invalidateCategories('restore');
    resolveStale([{ id: 'stale' }]);
    await staleLoad;
    await useCategoryStore.getState().ensureCategoriesLoaded();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useCategoryStore.getState().categories).toEqual([]);
  });

  it('reloads the complete category list when a mutation overlaps the initial request', async () => {
    let resolveStale!: (value: unknown[]) => void;
    const created = { id: 'created', name: 'Created' };
    const existing = { id: 'existing', name: 'Existing' };
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_conversation_categories') {
        listCalls += 1;
        return listCalls === 1
          ? new Promise((done) => { resolveStale = done; })
          : Promise.resolve([existing, created]);
      }
      if (command === 'create_conversation_category') return Promise.resolve(created);
      throw new Error(`Unexpected command: ${command}`);
    });
    const { useCategoryStore } = await import('../categoryStore');

    const initialLoad = useCategoryStore.getState().ensureCategoriesLoaded();
    await useCategoryStore.getState().createCategory({ name: 'Created' });
    resolveStale([]);
    await initialLoad;

    expect(listCalls).toBe(2);
    expect(useCategoryStore.getState().categories).toEqual([existing, created]);
    expect(useCategoryStore.getState().categoriesMeta.status).toBe('ready');
  });
});
