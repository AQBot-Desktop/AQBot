import { describe, expect, it, vi } from 'vitest';
import { createModuleResource, invalidateAllModuleResources } from '../moduleResource';

describe('createModuleResource', () => {
  it('caches empty values and coalesces concurrent loads', async () => {
    const load = vi.fn().mockResolvedValue([]);
    const resource = createModuleResource<unknown[]>();

    const [first, second] = await Promise.all([
      resource.ensure({ load }),
      resource.ensure({ load }),
    ]);
    const third = await resource.ensure({ load });

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(third).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent forced loads for the same key and revision', async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn().mockReturnValue(new Promise<string>((done) => { resolve = done; }));
    const resource = createModuleResource<string>();

    const first = resource.ensure({ key: 'account-a', force: true, load });
    const second = resource.ensure({ key: 'account-a', force: true, load });

    expect(load).toHaveBeenCalledTimes(1);
    resolve('fresh');
    await expect(Promise.all([first, second])).resolves.toEqual(['fresh', 'fresh']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads after invalidation overlaps an older request', async () => {
    let resolveOld!: (value: string) => void;
    const load = vi.fn()
      .mockReturnValueOnce(new Promise<string>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce('new');
    const resource = createModuleResource<string>();

    const pending = resource.ensure({ load });
    resource.invalidate();
    resolveOld('old');

    await expect(pending).resolves.toBe('new');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('uses explicitly replaced values without another load', async () => {
    const load = vi.fn().mockResolvedValue('remote');
    const resource = createModuleResource<string>();

    resource.set('local', 'account-a');

    await expect(resource.ensure({ key: 'account-a', load })).resolves.toBe('local');
    expect(load).not.toHaveBeenCalled();
  });

  it('invalidates registered module resources after an application restore', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after');
    const resource = createModuleResource<string>();
    await expect(resource.ensure({ load })).resolves.toBe('before');

    invalidateAllModuleResources();

    await expect(resource.ensure({ load })).resolves.toBe('after');
  });
});
