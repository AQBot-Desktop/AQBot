import { describe, expect, it, vi } from 'vitest';
import {
  RoleContextBindingsError,
  assertRoleContextBindingsAvailable,
  ensureLoadedRoleContextBindings,
  findMissingRoleContextBindings,
  formatRoleContextBindingItems,
  normalizeRoleContextIds,
} from '../roleContextBindings';

describe('normalizeRoleContextIds', () => {
  it('trims, drops empty values, and dedupes while keeping order', () => {
    expect(normalizeRoleContextIds([' kb-1 ', '', 'kb-2', 'kb-1', '  '])).toEqual(['kb-1', 'kb-2']);
    expect(normalizeRoleContextIds(null)).toEqual([]);
    expect(normalizeRoleContextIds(undefined)).toEqual([]);
  });
});

describe('findMissingRoleContextBindings', () => {
  it('returns selected ids that are absent from the loaded list', () => {
    expect(findMissingRoleContextBindings(['kb-1', 'kb-2', 'kb-3'], ['kb-2', 'kb-1'])).toEqual(['kb-3']);
    expect(findMissingRoleContextBindings([], ['kb-1'])).toEqual([]);
  });
});

describe('assertRoleContextBindingsAvailable', () => {
  it('throws a load-failed error when stores are not ready instead of claiming ids are missing', () => {
    expect(() => assertRoleContextBindingsAvailable({
      knowledgeBaseIds: ['missing-kb'],
      memoryNamespaceIds: ['missing-ns'],
      bases: [],
      namespaces: [],
      basesReady: false,
      namespacesReady: true,
    })).toThrow(RoleContextBindingsError);

    try {
      assertRoleContextBindingsAvailable({
        knowledgeBaseIds: ['missing-kb'],
        memoryNamespaceIds: [],
        bases: [],
        namespaces: [],
        basesReady: true,
        namespacesReady: false,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RoleContextBindingsError);
      expect((error as RoleContextBindingsError).kind).toBe('loadFailed');
      expect((error as RoleContextBindingsError).missingKnowledgeBaseIds).toEqual([]);
    }
  });

  it('throws a missing-bindings error listing absent ids when stores are ready', () => {
    try {
      assertRoleContextBindingsAvailable({
        knowledgeBaseIds: ['kb-ok', 'kb-gone'],
        memoryNamespaceIds: ['ns-gone'],
        bases: [{ id: 'kb-ok' }],
        namespaces: [{ id: 'ns-ok' }],
        basesReady: true,
        namespacesReady: true,
      });
      throw new Error('expected missing bindings error');
    } catch (error) {
      expect(error).toBeInstanceOf(RoleContextBindingsError);
      const bindingError = error as RoleContextBindingsError;
      expect(bindingError.kind).toBe('missing');
      expect(bindingError.missingKnowledgeBaseIds).toEqual(['kb-gone']);
      expect(bindingError.missingMemoryNamespaceIds).toEqual(['ns-gone']);
      expect(formatRoleContextBindingItems(
        bindingError.missingKnowledgeBaseIds,
        bindingError.missingMemoryNamespaceIds,
      )).toBe('kb-gone, ns-gone');
    }
  });

  it('accepts empty bindings when stores are ready', () => {
    expect(() => assertRoleContextBindingsAvailable({
      knowledgeBaseIds: [],
      memoryNamespaceIds: [],
      bases: [],
      namespaces: [],
      basesReady: true,
      namespacesReady: true,
    })).not.toThrow();
  });
});

describe('ensureLoadedRoleContextBindings', () => {
  it('loads resources then asserts against the latest snapshot', async () => {
    const loadBases = vi.fn().mockResolvedValue(undefined);
    const loadNamespaces = vi.fn().mockResolvedValue(undefined);
    await ensureLoadedRoleContextBindings({
      knowledgeBaseIds: ['kb-1'],
      memoryNamespaceIds: [],
      loadBases,
      loadNamespaces,
      getSnapshot: () => ({
        bases: [{ id: 'kb-1' }],
        namespaces: [],
        basesReady: true,
        namespacesReady: true,
      }),
    });
    expect(loadBases).toHaveBeenCalledOnce();
    expect(loadNamespaces).toHaveBeenCalledOnce();
  });

  it('maps load failures to a dedicated load-failed error', async () => {
    await expect(ensureLoadedRoleContextBindings({
      knowledgeBaseIds: [],
      memoryNamespaceIds: [],
      loadBases: async () => {
        throw new Error('network down');
      },
      loadNamespaces: async () => {},
      getSnapshot: () => ({
        bases: [],
        namespaces: [],
        basesReady: true,
        namespacesReady: true,
      }),
    })).rejects.toMatchObject({ name: 'RoleContextBindingsError', kind: 'loadFailed' });
  });
});
