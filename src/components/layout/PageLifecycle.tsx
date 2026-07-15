import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type PageCachePolicy = 'activity' | 'unmount';

export interface PageLifecycleContextValue {
  active: boolean;
}

const PageLifecycleContext = createContext<PageLifecycleContextValue>({ active: true });

interface PageLifecycleProviderProps {
  active: boolean;
  children: ReactNode;
}

export function PageLifecycleProvider({ active, children }: PageLifecycleProviderProps) {
  return (
    <PageLifecycleContext.Provider value={{ active }}>
      {children}
    </PageLifecycleContext.Provider>
  );
}

export function usePageLifecycle(): PageLifecycleContextValue {
  return useContext(PageLifecycleContext);
}

/** Releases transient UI/resources while Activity keeps the page state alive. */
export function usePageSuspendCleanup(cleanup: () => void): void {
  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;

  // React Activity disconnects effects when hidden and reconnects them when
  // visible. Avoid subscribing every heavy descendant to the `active` context:
  // that would force the whole retained tree to render on every page switch.
  useEffect(() => () => cleanupRef.current(), []);
}

/** Keeps an Ant overlay controlled and closes it when its Activity page hides. */
export function usePageTransientOpenState(initialOpen = false) {
  const [open, setOpen] = useState(initialOpen);
  usePageSuspendCleanup(() => setOpen(false));
  return [open, setOpen] as const;
}

/** Invalidates async work whenever an Activity page disconnects or reconnects. */
export function usePageConnectionGeneration() {
  const generationRef = useRef(0);
  useEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
    };
  }, []);
  return generationRef;
}
