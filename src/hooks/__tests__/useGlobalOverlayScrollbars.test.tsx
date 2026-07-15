import { useRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalOverlayScrollbars } from '@/hooks/useGlobalOverlayScrollbars';

const overlayState = vi.hoisted(() => ({
  elements: [] as HTMLElement[],
  instances: [] as Array<{ element: HTMLElement; destroy: ReturnType<typeof vi.fn> }>,
}));

vi.mock('overlayscrollbars', () => {
  const OverlayScrollbars = Object.assign(
    vi.fn((targetOrOptions: HTMLElement | { target: HTMLElement }) => {
      const element = targetOrOptions instanceof HTMLElement
        ? targetOrOptions
        : targetOrOptions.target;
      const instance = { element, destroy: vi.fn() };
      overlayState.elements.push(element);
      overlayState.instances.push(instance);
      return instance;
    }),
    {
      valid: vi.fn((element: HTMLElement) => element.dataset.preinitialized === 'true'),
    },
  );

  return { OverlayScrollbars };
});

function ScrollRoot({
  withPageScope = false,
  preinitialized = false,
}: {
  withPageScope?: boolean;
  preinitialized?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useGlobalOverlayScrollbars(rootRef);

  return (
    <div ref={rootRef} data-testid="scroll-root">
      {withPageScope ? (
        <section data-page-scroll-scope="chat" data-page-active="true" data-testid="page-scope">
          <div data-os-scrollbar data-testid="initial-scrollable" />
        </section>
      ) : (
        <div
          data-os-scrollbar
          data-preinitialized={preinitialized ? 'true' : undefined}
          data-testid="initial-scrollable"
        />
      )}
    </div>
  );
}

describe('useGlobalOverlayScrollbars', () => {
  beforeEach(() => {
    overlayState.elements.length = 0;
    overlayState.instances.length = 0;
  });

  afterEach(() => {
    document.querySelectorAll('[data-test-outside]').forEach((element) => element.remove());
    vi.restoreAllMocks();
  });

  it('initializes only added scrollables inside its root and destroys removed ones', async () => {
    render(<ScrollRoot />);
    const root = screen.getByTestId('scroll-root');
    const initial = screen.getByTestId('initial-scrollable');

    expect(overlayState.elements).toEqual([initial]);

    const outside = document.createElement('div');
    outside.dataset.osScrollbar = '';
    outside.dataset.testOutside = '';
    document.body.append(outside);

    const addedBranch = document.createElement('section');
    const addedScrollable = document.createElement('div');
    addedScrollable.dataset.osScrollbar = '';
    addedBranch.append(addedScrollable);
    act(() => root.append(addedBranch));

    await waitFor(() => expect(overlayState.elements).toEqual([initial, addedScrollable]));

    act(() => addedBranch.remove());
    await waitFor(() => expect(overlayState.instances[1].destroy).toHaveBeenCalledOnce());
    expect(overlayState.elements).not.toContain(outside);
    outside.remove();
  });

  it('releases hidden page scrollbars and initializes them again when visible', async () => {
    render(<ScrollRoot withPageScope />);
    const scope = screen.getByTestId('page-scope');
    const initial = screen.getByTestId('initial-scrollable');

    expect(overlayState.elements).toEqual([initial]);

    act(() => scope.setAttribute('data-page-active', 'false'));
    await waitFor(() => expect(overlayState.instances[0].destroy).toHaveBeenCalledOnce());

    act(() => scope.setAttribute('data-page-active', 'true'));
    await waitFor(() => expect(overlayState.elements).toEqual([initial, initial]));
  });

  it('does not wrap a scrollable that already owns an OverlayScrollbars instance', () => {
    render(<ScrollRoot preinitialized />);
    expect(overlayState.elements).toEqual([]);
  });
});
