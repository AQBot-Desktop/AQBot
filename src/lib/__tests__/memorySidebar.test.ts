import { describe, expect, it } from 'vitest';
import { MEMORY_L1_SIDEBAR_ID, type MemoryNamespace } from '@/types/memory';
import { mergeMemorySidebarItems } from '../memorySidebar';

function ns(id: string, sortOrder: number): MemoryNamespace {
  return {
    id,
    name: id,
    scope: 'global',
    sortOrder,
  };
}

describe('mergeMemorySidebarItems', () => {
  it('keeps always-on memory first when sort orders tie at zero', () => {
    const items = mergeMemorySidebarItems([ns('a', 0), ns('b', 1)], 0);
    expect(items.map((item) => item.id)).toEqual([MEMORY_L1_SIDEBAR_ID, 'a', 'b']);
  });

  it('places always-on memory among namespaces by sort order', () => {
    const items = mergeMemorySidebarItems([ns('a', 0), ns('b', 2)], 1);
    expect(items.map((item) => item.id)).toEqual(['a', MEMORY_L1_SIDEBAR_ID, 'b']);
  });
});
