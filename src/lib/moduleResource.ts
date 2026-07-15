interface EnsureModuleResourceOptions<T> {
  key?: string;
  force?: boolean;
  load: () => Promise<T>;
}

export interface ModuleResource<T> {
  ensure: (options: EnsureModuleResourceOptions<T>) => Promise<T>;
  invalidate: () => void;
  set: (value: T, key?: string) => void;
}

const moduleResources = new Set<{ invalidate: () => void }>();

export function invalidateAllModuleResources(): void {
  for (const resource of moduleResources) resource.invalidate();
}

/**
 * Keeps lightweight module data across component unmounts while coalescing IPC.
 * Mutations must either replace the cached value or invalidate it explicitly.
 */
export function createModuleResource<T>(): ModuleResource<T> {
  let revision = 0;
  let cached: { key: string; value: T } | null = null;
  let request: { key: string; revision: number; promise: Promise<T> } | null = null;

  const ensure = async ({
    key = 'default',
    force = false,
    load,
  }: EnsureModuleResourceOptions<T>): Promise<T> => {
    if (!force && cached?.key === key) return cached.value;
    if (request?.key === key && request.revision === revision) {
      return request.promise;
    }
    if (request) {
      await request.promise;
      return ensure({ key, force, load });
    }

    const requestRevision = revision;
    let promise!: Promise<T>;
    promise = load()
      .then(async (value) => {
        if (revision !== requestRevision) {
          if (request?.promise === promise) request = null;
          return ensure({ key, load });
        }
        cached = { key, value };
        return value;
      })
      .finally(() => {
        if (request?.promise === promise) request = null;
      });
    request = { key, revision: requestRevision, promise };
    return promise;
  };

  const resource: ModuleResource<T> = {
    ensure,
    invalidate: () => {
      revision += 1;
      cached = null;
    },
    set: (value, key = 'default') => {
      revision += 1;
      cached = { key, value };
    },
  };
  moduleResources.add(resource);
  return resource;
}
