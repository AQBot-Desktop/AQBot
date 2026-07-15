import { invoke } from '@/lib/invoke';

const MAX_RESOLVED_AVATAR_ENTRIES = 128;
const MAX_RESOLVED_AVATAR_BYTES = 16 * 1024 * 1024;
const MAX_IN_FLIGHT_AVATAR_ENTRIES = 128;

interface ResolvedAvatarEntry {
  source: string;
  estimatedBytes: number;
}

const resolvedSources = new Map<string, ResolvedAvatarEntry>();
const inFlightRequests = new Map<string, Promise<string>>();
const invalidationListeners = new Set<() => void>();
let resolvedBytes = 0;
let cacheRevision = 0;

function estimateEntryBytes(path: string, source: string): number {
  return (path.length + source.length) * 2;
}

function trimResolvedSources(): void {
  while (
    resolvedSources.size > MAX_RESOLVED_AVATAR_ENTRIES
    || resolvedBytes > MAX_RESOLVED_AVATAR_BYTES
  ) {
    const oldestPath = resolvedSources.keys().next().value;
    if (!oldestPath) break;
    const oldest = resolvedSources.get(oldestPath);
    if (oldest) resolvedBytes -= oldest.estimatedBytes;
    resolvedSources.delete(oldestPath);
  }
}

function rememberResolvedSource(path: string, source: string): void {
  const estimatedBytes = estimateEntryBytes(path, source);
  const existing = resolvedSources.get(path);
  if (existing) resolvedBytes -= existing.estimatedBytes;
  resolvedSources.delete(path);

  if (estimatedBytes > MAX_RESOLVED_AVATAR_BYTES) return;
  resolvedSources.set(path, { source, estimatedBytes });
  resolvedBytes += estimatedBytes;
  trimResolvedSources();
}

function trimInFlightRequests(): void {
  while (inFlightRequests.size > MAX_IN_FLIGHT_AVATAR_ENTRIES) {
    const oldestPath = inFlightRequests.keys().next().value;
    if (!oldestPath) break;
    inFlightRequests.delete(oldestPath);
  }
}

export function getCachedLegacyAvatarSource(path: string): string | undefined {
  const entry = resolvedSources.get(path);
  if (!entry) return undefined;
  resolvedSources.delete(path);
  resolvedSources.set(path, entry);
  return entry.source;
}

export function loadLegacyAvatarSource(path: string): Promise<string> {
  const cached = getCachedLegacyAvatarSource(path);
  if (cached !== undefined) return Promise.resolve(cached);

  const existingRequest = inFlightRequests.get(path);
  if (existingRequest) {
    inFlightRequests.delete(path);
    inFlightRequests.set(path, existingRequest);
    return existingRequest;
  }

  const requestRevision = cacheRevision;
  let trackedRequest!: Promise<string>;
  trackedRequest = invoke<string>('read_attachment_preview', { filePath: path })
    .then((source) => {
      if (requestRevision === cacheRevision) rememberResolvedSource(path, source);
      return source;
    })
    .finally(() => {
      if (inFlightRequests.get(path) === trackedRequest) {
        inFlightRequests.delete(path);
      }
    });

  inFlightRequests.set(path, trackedRequest);
  trimInFlightRequests();
  return trackedRequest;
}

export function subscribeLegacyAvatarSourceCache(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

export function getLegacyAvatarSourceCacheRevision(): number {
  return cacheRevision;
}

export function clearLegacyAvatarSourceCache(): void {
  resolvedSources.clear();
  inFlightRequests.clear();
  resolvedBytes = 0;
  cacheRevision += 1;
  for (const listener of invalidationListeners) listener();
}

export function getLegacyAvatarSourceCacheStats() {
  return {
    resolvedEntries: resolvedSources.size,
    resolvedBytes,
    inFlightEntries: inFlightRequests.size,
    maxResolvedEntries: MAX_RESOLVED_AVATAR_ENTRIES,
    maxResolvedBytes: MAX_RESOLVED_AVATAR_BYTES,
    maxInFlightEntries: MAX_IN_FLIGHT_AVATAR_ENTRIES,
  };
}
