import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultiModelColumnScroll } from '../MultiModelColumnScroll';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function createScrollBox(scrollTop = 0) {
  const scrollBox = document.createElement('div');
  scrollBox.className = 'ant-bubble-list-scroll-box';
  scrollBox.style.flexDirection = 'column-reverse';
  let top = scrollTop;
  Object.defineProperties(scrollBox, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1400 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
        scrollBox.dispatchEvent(new Event('scroll', { bubbles: true }));
      },
    },
  });
  scrollBox.scrollTo = ((options?: ScrollToOptions | number) => {
    if (typeof options === 'number') {
      scrollBox.scrollTop = options;
      return;
    }
    if (options && typeof options.top === 'number') {
      scrollBox.scrollTop = options.top;
    }
  }) as typeof scrollBox.scrollTo;
  return scrollBox;
}

describe('MultiModelColumnScroll', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows a per-column back-to-bottom control only for the column that left the bottom', async () => {
    const firstBox = createScrollBox(0);
    const secondBox = createScrollBox(-450);
    const onScroll = vi.fn();

    const { rerender } = render(
      <div>
        <MultiModelColumnScroll onScroll={onScroll}>
          <div data-testid="lane-a" />
        </MultiModelColumnScroll>
        <MultiModelColumnScroll>
          <div data-testid="lane-b" />
        </MultiModelColumnScroll>
      </div>,
    );

    const roots = screen.getAllByTestId('multi-model-column-scroll');
    roots[0]!.querySelector('[data-testid="lane-a"]')?.replaceWith(firstBox);
    roots[1]!.querySelector('[data-testid="lane-b"]')?.replaceWith(secondBox);

    rerender(
      <div>
        <MultiModelColumnScroll onScroll={onScroll}>
          <div />
        </MultiModelColumnScroll>
        <MultiModelColumnScroll>
          <div />
        </MultiModelColumnScroll>
      </div>,
    );

    act(() => {
      firstBox.dispatchEvent(new Event('scroll', { bubbles: true }));
      secondBox.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('multi-model-column-scroll-to-bottom')).toHaveLength(1);
    });

    fireEvent.click(screen.getByTestId('multi-model-column-scroll-to-bottom'));
    expect(secondBox.scrollTop).toBe(0);
    expect(firstBox.scrollTop).toBe(0);
  });
});
