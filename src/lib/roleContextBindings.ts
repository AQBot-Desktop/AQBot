export type RoleContextBindingsErrorKind = 'missing' | 'loadFailed';

export class RoleContextBindingsError extends Error {
  readonly kind: RoleContextBindingsErrorKind;
  readonly missingKnowledgeBaseIds: string[];
  readonly missingMemoryNamespaceIds: string[];

  constructor(
    kind: RoleContextBindingsErrorKind,
    missingKnowledgeBaseIds: string[] = [],
    missingMemoryNamespaceIds: string[] = [],
  ) {
    super(kind === 'loadFailed' ? 'ROLE_CONTEXT_BINDINGS_LOAD_FAILED' : 'ROLE_CONTEXT_BINDINGS_MISSING');
    this.name = 'RoleContextBindingsError';
    this.kind = kind;
    this.missingKnowledgeBaseIds = missingKnowledgeBaseIds;
    this.missingMemoryNamespaceIds = missingMemoryNamespaceIds;
  }
}

export function isRoleContextBindingsError(error: unknown): error is RoleContextBindingsError {
  return error instanceof RoleContextBindingsError;
}

export function normalizeRoleContextIds(ids?: string[] | null): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids ?? []) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function findMissingRoleContextBindings(ids: string[], availableIds: string[]): string[] {
  const available = new Set(availableIds);
  return ids.filter((id) => !available.has(id));
}

export function formatRoleContextBindingItems(
  knowledgeBaseIds: string[],
  memoryNamespaceIds: string[],
): string {
  return [...knowledgeBaseIds, ...memoryNamespaceIds].join(', ');
}

export function assertRoleContextBindingsAvailable(input: {
  knowledgeBaseIds?: string[] | null;
  memoryNamespaceIds?: string[] | null;
  bases: Array<{ id: string }>;
  namespaces: Array<{ id: string }>;
  basesReady: boolean;
  namespacesReady: boolean;
}): void {
  if (!input.basesReady || !input.namespacesReady) {
    throw new RoleContextBindingsError('loadFailed');
  }
  const knowledgeBaseIds = normalizeRoleContextIds(input.knowledgeBaseIds);
  const memoryNamespaceIds = normalizeRoleContextIds(input.memoryNamespaceIds);
  const missingKnowledgeBaseIds = findMissingRoleContextBindings(
    knowledgeBaseIds,
    input.bases.map((item) => item.id),
  );
  const missingMemoryNamespaceIds = findMissingRoleContextBindings(
    memoryNamespaceIds,
    input.namespaces.map((item) => item.id),
  );
  if (missingKnowledgeBaseIds.length > 0 || missingMemoryNamespaceIds.length > 0) {
    throw new RoleContextBindingsError('missing', missingKnowledgeBaseIds, missingMemoryNamespaceIds);
  }
}

export async function ensureLoadedRoleContextBindings(input: {
  knowledgeBaseIds?: string[] | null;
  memoryNamespaceIds?: string[] | null;
  loadBases: () => Promise<void>;
  loadNamespaces: () => Promise<void>;
  getSnapshot: () => {
    bases: Array<{ id: string }>;
    namespaces: Array<{ id: string }>;
    basesReady: boolean;
    namespacesReady: boolean;
  };
}): Promise<void> {
  try {
    await Promise.all([input.loadBases(), input.loadNamespaces()]);
  } catch {
    throw new RoleContextBindingsError('loadFailed');
  }
  assertRoleContextBindingsAvailable({
    knowledgeBaseIds: input.knowledgeBaseIds,
    memoryNamespaceIds: input.memoryNamespaceIds,
    ...input.getSnapshot(),
  });
}
