import { useEffect, type RefObject } from 'react';
import { OverlayScrollbars } from 'overlayscrollbars';

/**
 * Selectors for elements that should receive custom overlay scrollbars.
 *
 * `.overflow-y-auto` — Tailwind utility; covers sidebar, settings panels, etc.
 * `[data-os-scrollbar]` — explicit opt-in for containers using inline styles.
 *
 * NOTE: antd Bubble.List is excluded — it uses `flex-direction: column-reverse`
 * which inverts the scroll coordinate system.  OverlayScrollbars cannot handle
 * reversed scroll containers, so the chat area uses a separate lightweight
 * scroll indicator (`ChatScrollIndicator`) instead.
 */
const SCROLLABLE_SELECTORS = [
  '.overflow-y-auto',
  '[data-os-scrollbar]',
];
const SCROLLABLE_SELECTOR = SCROLLABLE_SELECTORS.join(',');
const PAGE_SCROLL_SCOPE_SELECTOR = '[data-page-scroll-scope]';

const OS_OPTIONS: Parameters<typeof OverlayScrollbars>[1] = {
  scrollbars: {
    theme: 'os-theme-aqbot',
    autoHide: 'scroll',
    autoHideDelay: 600,
    autoHideSuspend: true,
    clickScroll: true,
  },
  overflow: {
    x: 'hidden',
  },
};

/**
 * Finds scrollable containers under one stable application root and
 * initialises OverlayScrollbars on them. Mutations are processed incrementally:
 * only added/removed branches and page visibility scopes are inspected.
 *
 * The `elements.viewport` option is passed so that OverlayScrollbars re-uses
 * each existing scrollable element as the viewport, minimising DOM
 * restructuring.
 */
export function useGlobalOverlayScrollbars(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const instances = new WeakMap<HTMLElement, ReturnType<typeof OverlayScrollbars>>();
    const trackedElements = new Set<HTMLElement>();
    const pendingInitializations = new Set<HTMLElement>();
    let initializationFrameId: number | null = null;

    function initElement(el: HTMLElement) {
      if (instances.has(el) || OverlayScrollbars.valid(el) || !root?.contains(el)) return;

      const pageScope = el.closest<HTMLElement>(PAGE_SCROLL_SCOPE_SELECTOR);
      if (pageScope?.dataset.pageActive === 'false') return;

      try {
        const inst = OverlayScrollbars(
          { target: el, elements: { viewport: el } },
          OS_OPTIONS,
        );
        instances.set(el, inst);
        trackedElements.add(el);
      } catch (error) {
        console.warn('Failed to initialize overlay scrollbar:', error);
      }
    }

    function scanSubtree(node: Node) {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches(SCROLLABLE_SELECTOR)) initElement(node);
      node.querySelectorAll<HTMLElement>(SCROLLABLE_SELECTOR).forEach(initElement);
    }

    function queueSubtreeInitialization(node: Node) {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches(SCROLLABLE_SELECTOR)) pendingInitializations.add(node);
      node.querySelectorAll<HTMLElement>(SCROLLABLE_SELECTOR).forEach((element) => {
        pendingInitializations.add(element);
      });
    }

    function scheduleNextInitialization() {
      if (initializationFrameId !== null || pendingInitializations.size === 0) return;
      initializationFrameId = requestAnimationFrame(() => {
        initializationFrameId = null;
        const next = pendingInitializations.values().next().value as HTMLElement | undefined;
        if (next) {
          pendingInitializations.delete(next);
          initElement(next);
        }
        scheduleNextInitialization();
      });
    }

    function destroyElement(el: HTMLElement) {
      const instance = instances.get(el);
      if (!instance) return;
      instance.destroy();
      instances.delete(el);
      trackedElements.delete(el);
    }

    function destroySubtree(node: Node) {
      if (!(node instanceof HTMLElement)) return;
      pendingInitializations.forEach((element) => {
        if (node === element || node.contains(element)) pendingInitializations.delete(element);
      });
      trackedElements.forEach((el) => {
        if (node === el || node.contains(el)) {
          destroyElement(el);
        }
      });
    }

    scanSubtree(root);

    const addedNodes = new Set<Node>();
    const removedNodes = new Set<Node>();
    const changedPageScopes = new Set<HTMLElement>();
    let rafId: number | null = null;

    const flushMutations = () => {
      rafId = null;

      removedNodes.forEach(destroySubtree);
      removedNodes.clear();

      changedPageScopes.forEach((scope) => {
        if (!root.contains(scope)) return;
        if (scope.dataset.pageActive === 'false') {
          destroySubtree(scope);
        } else {
          // Restoring a retained page can expose several scroll containers at
          // once. Initialize one per frame so scrollbar setup cannot turn the
          // first visible frame into a long task.
          queueSubtreeInitialization(scope);
        }
      });
      changedPageScopes.clear();

      addedNodes.forEach((node) => {
        if (root.contains(node)) scanSubtree(node);
      });
      addedNodes.clear();
      scheduleNextInitialization();
    };

    const scheduleFlush = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(flushMutations);
    };

    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'attributes') {
          changedPageScopes.add(record.target as HTMLElement);
          return;
        }

        record.addedNodes.forEach((node) => addedNodes.add(node));
        record.removedNodes.forEach((node) => removedNodes.add(node));
      });
      scheduleFlush();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-page-active'],
    });

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (initializationFrameId !== null) cancelAnimationFrame(initializationFrameId);
      pendingInitializations.clear();
      trackedElements.forEach((el) => {
        const inst = instances.get(el);
        if (inst) {
          inst.destroy();
        }
      });
      trackedElements.clear();
    };
  }, [rootRef]);
}
