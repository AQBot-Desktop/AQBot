import { MEMORY_L1_SIDEBAR_ID, type MemoryNamespace } from '@/types/memory';

export type MemorySidebarItem =
  | { kind: 'l1'; id: typeof MEMORY_L1_SIDEBAR_ID; sortOrder: number }
  | { kind: 'namespace'; id: string; sortOrder: number; ns: MemoryNamespace };

export function mergeMemorySidebarItems(
  namespaces: MemoryNamespace[],
  l1SortOrder = 0,
): MemorySidebarItem[] {
  const items: MemorySidebarItem[] = [
    { kind: 'l1', id: MEMORY_L1_SIDEBAR_ID, sortOrder: l1SortOrder },
    ...namespaces.map((ns) => ({
      kind: 'namespace' as const,
      id: ns.id,
      sortOrder: ns.sortOrder,
      ns,
    })),
  ];
  items.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.kind === 'l1') return -1;
    if (b.kind === 'l1') return 1;
    return 0;
  });
  return items;
}
