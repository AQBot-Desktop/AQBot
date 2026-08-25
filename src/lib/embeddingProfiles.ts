/** Reserved embedding_provider value for the onboard offline model. Not a chat Provider id. */
export const BUILTIN_EMBEDDING_REF = 'builtin::multilingual-e5-small';
export const BUILTIN_EMBEDDING_DIMENSIONS = 384;

export function isBuiltinEmbeddingRef(value: string | undefined | null): boolean {
  return value === BUILTIN_EMBEDDING_REF;
}
