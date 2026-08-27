import { useEffect, useState } from 'react';
import { loadSystemFontFaces, peekSystemFontFaces } from '@/lib/systemFonts';

export function useSystemFontFaces(family: string) {
  const key = family.trim();
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    loadSystemFontFaces(key).then(() => {
      if (!cancelled) setTick((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return peekSystemFontFaces(key) ?? [];
}
