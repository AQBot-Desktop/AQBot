import { afterEach, describe, expect, it } from 'vitest';

describe('performance instrumentation', () => {
  afterEach(() => {
    delete (window as Window & { __AQBOT_PERF__?: unknown }).__AQBOT_PERF__;
  });

  it('records invoke size and page commits only when a harness is installed', async () => {
    const state = { longTasks: [] as unknown[] };
    (window as Window & { __AQBOT_PERF__?: unknown }).__AQBOT_PERF__ = state;
    const {
      beginMeasuredInvoke,
      beginPageRender,
      recordMeasuredInvoke,
      recordPageCommit,
    } = await import('../performanceInstrumentation');

    const startedAt = beginMeasuredInvoke();
    recordMeasuredInvoke('list_conversations', { limit: 10 }, [{ id: 'conv-1' }], startedAt, true);
    const renderStartedAt = beginPageRender();
    recordPageCommit('chat', renderStartedAt);

    expect(state).toMatchObject({
      invokes: [{ command: 'list_conversations', ok: true }],
      pageCommits: [{ page: 'chat' }],
    });
    expect((state as any).invokes[0].requestBytes).toBeGreaterThan(0);
    expect((state as any).invokes[0].responseBytes).toBeGreaterThan(0);
    expect((state as any).pageCommits[0].renderDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not start timing without an installed harness', async () => {
    const { beginMeasuredInvoke, beginPageRender } = await import('../performanceInstrumentation');
    expect(beginMeasuredInvoke()).toBeNull();
    expect(beginPageRender()).toBeNull();
  });
});
