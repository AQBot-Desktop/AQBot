export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ResourceMeta {
  status: ResourceStatus;
  key: string | null;
  loadedAt: number | null;
  revision: number;
}

export interface EnsureLoadedOptions {
  key?: string;
  force?: boolean;
  maxAgeMs?: number;
}

export type ResourceInvalidationReason = 'mutation' | 'restore' | 'import' | 'path-change';

export function isResourceFresh(meta: ResourceMeta, options: EnsureLoadedOptions = {}): boolean {
  if (meta.status !== 'ready') return false;
  if (options.key !== undefined && meta.key !== options.key) return false;
  if (options.maxAgeMs === undefined || meta.loadedAt === null) return true;
  return Date.now() - meta.loadedAt <= options.maxAgeMs;
}
