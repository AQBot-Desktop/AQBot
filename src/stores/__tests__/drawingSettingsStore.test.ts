import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('drawingSettingsStore', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('persists drawing parameter selections across store reloads', async () => {
    const { useDrawingSettingsStore } = await import('../drawingSettingsStore');

    useDrawingSettingsStore.getState().patchSettings({
      providerId: 'provider-1',
      size: '2048x2048',
      quality: 'high',
      outputFormat: 'webp',
      outputCompression: 88,
      n: 4,
    });

    vi.resetModules();
    const { useDrawingSettingsStore: reloadedStore } = await import('../drawingSettingsStore');

    expect(reloadedStore.getState().settings).toMatchObject({
      providerId: 'provider-1',
      modelId: 'gpt-image-2',
      size: '2048x2048',
      quality: 'high',
      outputFormat: 'webp',
      outputCompression: undefined,
      n: 4,
    });
  });

  it('normalizes unsupported persisted values before exposing them to the page', async () => {
    localStorage.setItem('aqbot_drawing_settings', JSON.stringify({
      state: {
        settings: {
          modelId: 'gpt-image-2',
          size: 'invalid-size',
          quality: 'ultra',
          outputFormat: 'jpeg',
          background: 'transparent',
          outputCompression: 150,
          n: 30,
        },
      },
      version: 0,
    }));

    const { useDrawingSettingsStore } = await import('../drawingSettingsStore');

    expect(useDrawingSettingsStore.getState().settings).toMatchObject({
      modelId: 'gpt-image-2',
      size: 'auto',
      quality: 'auto',
      outputFormat: 'jpeg',
      background: 'auto',
      outputCompression: undefined,
      n: 10,
    });
  });
});
