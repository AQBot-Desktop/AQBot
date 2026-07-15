export interface PerformanceInvokeEntry {
  command: string;
  startedAt: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  ok: boolean;
}

export interface PerformancePageCommitEntry {
  page: string;
  at: number;
  renderDurationMs: number;
}

interface PerformanceHarnessState {
  invokes?: PerformanceInvokeEntry[];
  pageCommits?: PerformancePageCommitEntry[];
}

type PerformanceWindow = Window & { __AQBOT_PERF__?: PerformanceHarnessState };
const MAX_RECORDED_ENTRIES = 5_000;

function getHarnessState(): PerformanceHarnessState | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as PerformanceWindow).__AQBOT_PERF__;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function estimateJsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return 0;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return 0;
  }
}

function appendBounded<T>(items: T[], value: T): void {
  items.push(value);
  if (items.length > MAX_RECORDED_ENTRIES) {
    items.splice(0, items.length - MAX_RECORDED_ENTRIES);
  }
}

export function beginMeasuredInvoke(): number | null {
  return getHarnessState() ? now() : null;
}

export function beginPageRender(): number | null {
  return getHarnessState() ? now() : null;
}

export function recordMeasuredInvoke(
  command: string,
  args: Record<string, unknown> | undefined,
  result: unknown,
  startedAt: number | null,
  ok: boolean,
): void {
  if (startedAt === null) return;
  const state = getHarnessState();
  if (!state) return;
  const invokes = state.invokes ?? (state.invokes = []);
  appendBounded(invokes, {
    command,
    startedAt,
    durationMs: now() - startedAt,
    requestBytes: estimateJsonBytes(args),
    responseBytes: estimateJsonBytes(result),
    ok,
  });
}

export function recordPageCommit(page: string, renderStartedAt: number | null): void {
  const state = getHarnessState();
  if (!state) return;
  const pageCommits = state.pageCommits ?? (state.pageCommits = []);
  const committedAt = now();
  appendBounded(pageCommits, {
    page,
    at: committedAt,
    renderDurationMs: renderStartedAt === null ? 0 : committedAt - renderStartedAt,
  });
}
