import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

import {
  clearLegacyAvatarSourceCache,
  getLegacyAvatarSourceCacheStats,
  loadLegacyAvatarSource,
} from '../legacyAvatarMedia';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('legacyAvatarMedia', () => {
  beforeEach(() => {
    clearLegacyAvatarSourceCache();
    invokeMock.mockReset();
  });

  it('coalesces concurrent reads and reuses the resolved source', async () => {
    const read = deferred<string>();
    invokeMock.mockReturnValue(read.promise);

    const first = loadLegacyAvatarSource('images/avatar.png');
    const second = loadLegacyAvatarSource('images/avatar.png');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(getLegacyAvatarSourceCacheStats().inFlightEntries).toBe(1);

    read.resolve('data:image/png;base64,avatar');
    await expect(Promise.all([first, second])).resolves.toEqual([
      'data:image/png;base64,avatar',
      'data:image/png;base64,avatar',
    ]);
    await expect(loadLegacyAvatarSource('images/avatar.png')).resolves.toBe(
      'data:image/png;base64,avatar',
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(getLegacyAvatarSourceCacheStats()).toMatchObject({
      resolvedEntries: 1,
      inFlightEntries: 0,
    });
  });

  it('bounds resolved and in-flight entries with LRU eviction', async () => {
    invokeMock.mockImplementation((_command, args: { filePath: string }) => (
      Promise.resolve(`data:image/png;base64,${args.filePath}`)
    ));
    const { maxResolvedEntries } = getLegacyAvatarSourceCacheStats();

    for (let index = 0; index <= maxResolvedEntries; index += 1) {
      await loadLegacyAvatarSource(`images/resolved-${index}.png`);
    }
    expect(getLegacyAvatarSourceCacheStats().resolvedEntries).toBe(maxResolvedEntries);

    await loadLegacyAvatarSource('images/resolved-0.png');
    expect(invokeMock).toHaveBeenCalledTimes(maxResolvedEntries + 2);

    clearLegacyAvatarSourceCache();
    invokeMock.mockReset();
    const reads: Array<ReturnType<typeof deferred<string>>> = [];
    invokeMock.mockImplementation(() => {
      const read = deferred<string>();
      reads.push(read);
      return read.promise;
    });
    const { maxInFlightEntries } = getLegacyAvatarSourceCacheStats();
    const requests = Array.from(
      { length: maxInFlightEntries + 1 },
      (_, index) => loadLegacyAvatarSource(`images/in-flight-${index}.png`),
    );
    expect(getLegacyAvatarSourceCacheStats().inFlightEntries).toBe(maxInFlightEntries);

    const repeatedEvictedRequest = loadLegacyAvatarSource('images/in-flight-0.png');
    expect(invokeMock).toHaveBeenCalledTimes(maxInFlightEntries + 2);
    expect(getLegacyAvatarSourceCacheStats().inFlightEntries).toBe(maxInFlightEntries);

    reads.forEach((read, index) => read.resolve(`data:image/png;base64,${index}`));
    await Promise.all([...requests, repeatedEvictedRequest]);
    expect(getLegacyAvatarSourceCacheStats().inFlightEntries).toBe(0);
    expect(getLegacyAvatarSourceCacheStats().resolvedEntries).toBeLessThanOrEqual(maxResolvedEntries);
  });

  it('does not repopulate the cache from a request started before invalidation', async () => {
    const staleRead = deferred<string>();
    invokeMock.mockReturnValueOnce(staleRead.promise);
    const staleRequest = loadLegacyAvatarSource('images/avatar.png');

    clearLegacyAvatarSourceCache();
    staleRead.resolve('data:image/png;base64,stale');
    await staleRequest;
    expect(getLegacyAvatarSourceCacheStats().resolvedEntries).toBe(0);

    invokeMock.mockResolvedValueOnce('data:image/png;base64,fresh');
    await expect(loadLegacyAvatarSource('images/avatar.png')).resolves.toBe(
      'data:image/png;base64,fresh',
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
