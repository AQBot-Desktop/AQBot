import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const isTauriMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

describe('stored media sources', () => {
  beforeEach(async () => {
    invokeMock.mockReset();
    isTauriMock.mockReset();
    const { clearStoredMediaSourceCache } = await import('../storedMedia');
    clearStoredMediaSourceCache();
  });

  it('builds the native and Windows custom protocol URLs', async () => {
    const { buildStoredMediaUrl } = await import('../storedMedia');

    expect(buildStoredMediaUrl('file-123', false)).toBe('aqbot-media://stored/file-123');
    expect(buildStoredMediaUrl('file-123', true)).toBe(
      'http://aqbot-media.localhost/stored/file-123',
    );
    expect(() => buildStoredMediaUrl('../bad', false)).toThrow('Invalid stored file id');
  });

  it('normalizes renderable media URLs without changing code examples', async () => {
    const { normalizeStoredMediaUrlsForPlatform } = await import('../storedMedia');
    const content = [
      '![markdown](aqbot-media://stored/image-1)',
      '<img src="aqbot-media://stored/image_2">',
      '`aqbot-media://stored/inline-code`',
      '```md',
      '![code](aqbot-media://stored/fenced-code)',
      '```',
    ].join('\n');

    expect(normalizeStoredMediaUrlsForPlatform(content, true)).toBe([
      '![markdown](http://aqbot-media.localhost/stored/image-1)',
      '<img src="http://aqbot-media.localhost/stored/image_2">',
      '`aqbot-media://stored/inline-code`',
      '```md',
      '![code](aqbot-media://stored/fenced-code)',
      '```',
    ].join('\n'));
  });

  it('converts Windows WebView URLs back to the native protocol', async () => {
    const { normalizeStoredMediaUrlsForPlatform } = await import('../storedMedia');

    expect(normalizeStoredMediaUrlsForPlatform(
      '![image](http://aqbot-media.localhost/stored/image-1)',
      false,
    )).toBe('![image](aqbot-media://stored/image-1)');
  });

  it('normalizes stored media scheme and host casing without touching code', async () => {
    const { normalizeStoredMediaUrlsForPlatform } = await import('../storedMedia');

    expect(normalizeStoredMediaUrlsForPlatform([
      '![native](AQBOT-MEDIA://STORED/image-1)',
      '<img src="HTTP://AQBOT-MEDIA.LOCALHOST/STORED/image_2">',
      '`AQBOT-MEDIA://STORED/code-example`',
    ].join('\n'), false)).toBe([
      '![native](aqbot-media://stored/image-1)',
      '<img src="aqbot-media://stored/image_2">',
      '`AQBOT-MEDIA://STORED/code-example`',
    ].join('\n'));
  });

  it('uses the direct protocol in Tauri without preview IPC', async () => {
    isTauriMock.mockReturnValue(true);
    const { loadStoredMediaSource } = await import('../storedMedia');

    await expect(loadStoredMediaSource('file-123', 'images/image.png')).resolves.toContain(
      '/stored/file-123',
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('coalesces browser preview requests by stored file id', async () => {
    isTauriMock.mockReturnValue(false);
    invokeMock.mockResolvedValue('data:image/png;base64,abc');
    const { loadStoredMediaSource } = await import('../storedMedia');

    const [first, second] = await Promise.all([
      loadStoredMediaSource('file-123', 'images/image.png'),
      loadStoredMediaSource('file-123', 'images/image.png'),
    ]);

    expect(first).toBe('data:image/png;base64,abc');
    expect(second).toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps browser preview caching bounded and invalidates late requests', async () => {
    isTauriMock.mockReturnValue(false);
    invokeMock.mockImplementation((_command, { filePath }) => (
      Promise.resolve(`data:image/png;base64,${String(filePath).padEnd(512, 'x')}`)
    ));
    const {
      clearStoredMediaSourceCache,
      getStoredMediaSourceCacheStats,
      loadStoredMediaSource,
    } = await import('../storedMedia');

    for (let index = 0; index < 160; index += 1) {
      await loadStoredMediaSource(`file-${index}`, `images/${index}.png`);
    }
    const stats = getStoredMediaSourceCacheStats();
    expect(stats.resolvedEntries).toBeLessThanOrEqual(stats.maxEntries);
    expect(stats.resolvedBytes).toBeLessThanOrEqual(stats.maxBytes);
    expect(stats.inFlightEntries).toBe(0);

    let resolveLate!: (source: string) => void;
    invokeMock.mockReturnValueOnce(new Promise<string>((resolve) => { resolveLate = resolve; }));
    const late = loadStoredMediaSource('late', 'images/late.png');
    clearStoredMediaSourceCache();
    resolveLate('data:image/png;base64,late');
    await late;
    expect(getStoredMediaSourceCacheStats().resolvedEntries).toBe(0);
  });
});
