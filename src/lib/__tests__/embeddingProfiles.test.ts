import { describe, expect, it } from 'vitest';
import { BUILTIN_EMBEDDING_DIMENSIONS, BUILTIN_EMBEDDING_REF, isBuiltinEmbeddingRef } from '../embeddingProfiles';

describe('builtin embedding ref', () => {
  it('uses a reserved key that is not a chat provider id', () => {
    expect(BUILTIN_EMBEDDING_REF).toBe('builtin::multilingual-e5-small');
    expect(isBuiltinEmbeddingRef(BUILTIN_EMBEDDING_REF)).toBe(true);
    expect(isBuiltinEmbeddingRef('provider-1::text-embedding-3-small')).toBe(false);
    expect(BUILTIN_EMBEDDING_DIMENSIONS).toBe(384);
  });
});
