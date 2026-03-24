import { useEffect, useState } from 'react';

export function useResolvedDarkMode(themeMode: string): boolean {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (themeMode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themeMode]);

  if (themeMode === 'dark') return true;
  if (themeMode === 'light') return false;
  return systemDark;
}
