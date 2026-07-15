import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: any) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

describe('chatMarkdownWorker', () => {
  beforeEach(() => {
    vi.resetModules();
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('terminates synchronous parsing on abort and creates a clean worker for retry', async () => {
    const { parseChatMarkdownOffMainThread } = await import('../chatMarkdownWorker');
    const controller = new AbortController();
    const firstParse = parseChatMarkdownOffMainThread('x'.repeat(20_001), controller.signal);
    const firstWorker = FakeWorker.instances[0];
    const firstRequest = firstWorker.postMessage.mock.calls[0]?.[0];

    controller.abort();
    await expect(firstParse).rejects.toMatchObject({ name: 'AbortError' });
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);

    const retry = parseChatMarkdownOffMainThread('retry');
    const secondWorker = FakeWorker.instances[1];
    expect(secondWorker).not.toBe(firstWorker);
    const retryRequest = secondWorker.postMessage.mock.calls[0]?.[0];
    secondWorker.emit('message', {
      data: { type: 'result', id: retryRequest.id, nodes: [] },
    });

    await expect(retry).resolves.toEqual([]);
    expect(firstRequest.type).toBe('parse');
  });

  it('continues queued parses after aborting the active worker task', async () => {
    const { parseChatMarkdownOffMainThread } = await import('../chatMarkdownWorker');
    const controller = new AbortController();
    const activeParse = parseChatMarkdownOffMainThread('active', controller.signal);
    const queuedParse = parseChatMarkdownOffMainThread('queued');
    const firstWorker = FakeWorker.instances[0];

    expect(firstWorker.postMessage).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(activeParse).rejects.toMatchObject({ name: 'AbortError' });

    const replacementWorker = FakeWorker.instances[1];
    const queuedRequest = replacementWorker.postMessage.mock.calls[0]?.[0];
    replacementWorker.emit('message', {
      data: { type: 'result', id: queuedRequest.id, nodes: [] },
    });

    await expect(queuedParse).resolves.toEqual([]);
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('removes an aborted queued parse without interrupting the active parse', async () => {
    const { parseChatMarkdownOffMainThread } = await import('../chatMarkdownWorker');
    const activeParse = parseChatMarkdownOffMainThread('active');
    const queuedController = new AbortController();
    const queuedParse = parseChatMarkdownOffMainThread('queued', queuedController.signal);
    const activeWorker = FakeWorker.instances[0];
    const activeRequest = activeWorker.postMessage.mock.calls[0]?.[0];

    queuedController.abort();
    await expect(queuedParse).rejects.toMatchObject({ name: 'AbortError' });
    expect(activeWorker.terminate).not.toHaveBeenCalled();

    activeWorker.emit('message', {
      data: { type: 'result', id: activeRequest.id, nodes: [] },
    });
    await expect(activeParse).resolves.toEqual([]);
    expect(activeWorker.postMessage).toHaveBeenCalledTimes(1);
  });
});
