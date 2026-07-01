export function perfTrace(label: string, data?: Record<string, unknown>) {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;

  try {
    if (window.localStorage.getItem('aqbotPerfTrace') !== '1') return;
  } catch {
    return;
  }

  console.info(`[aqbot:perf] ${label}`, data ?? {});
}

export function perfNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function perfTraceDuration(label: string, startedAt: number, data?: Record<string, unknown>) {
  perfTrace(label, {
    ...data,
    durationMs: Math.round((perfNow() - startedAt) * 10) / 10,
  });
}
