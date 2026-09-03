import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatScrollIndicator } from '../ChatScrollIndicator';

function createScrollableBubbleList() {
  const scrollBox = document.createElement('div');
  scrollBox.className = 'ant-bubble-list-scroll-box';
  scrollBox.style.flexDirection = 'column-reverse';

  let scrollTop = 0;
  Object.defineProperties(scrollBox, {
    clientHeight: { configurable: true, value: 800 },
    scrollHeight: { configurable: true, value: 2000 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        scrollBox.dispatchEvent(new Event('scroll'));
      },
    },
  });

  document.body.appendChild(scrollBox);
  return scrollBox;
}

describe('ChatScrollIndicator', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reports user scroll intent before dragging the custom scrollbar thumb', async () => {
    createScrollableBubbleList();
    const onUserScrollIntent = vi.fn();

    render(<ChatScrollIndicator onUserScrollIntent={onUserScrollIntent} />);

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    await waitFor(() => {
      expect(document.querySelector('.chat-scroll-indicator')).toBeInTheDocument();
    });

    const thumb = document.querySelector('.chat-scroll-indicator') as HTMLElement;
    fireEvent.pointerDown(thumb, { clientY: 10 });

    expect(onUserScrollIntent).toHaveBeenCalledTimes(1);
  });

  it('reports user scroll intent before jumping from the custom scrollbar track', async () => {
    createScrollableBubbleList();
    const onUserScrollIntent = vi.fn();

    render(<ChatScrollIndicator onUserScrollIntent={onUserScrollIntent} />);

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    await waitFor(() => {
      expect(document.querySelector('.chat-scroll-indicator-track')).toBeInTheDocument();
    });

    const track = document.querySelector('.chat-scroll-indicator-track') as HTMLElement;
    fireEvent.pointerDown(track, { clientY: 400 });

    expect(onUserScrollIntent).toHaveBeenCalledTimes(1);
  });

  it('drags only the scroll box inside the provided root', async () => {
    const first = createScrollableBubbleList();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const second = createScrollableBubbleList();
    root.appendChild(second);
    first.scrollTop = 0;
    second.scrollTop = 0;
    const scrollRoot = createRef<ParentNode | null>();
    scrollRoot.current = root;

    const { container } = render(
      <ChatScrollIndicator scrollRoot={scrollRoot} persistWhenScrollable />,
    );

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const track = container.querySelector('.chat-scroll-indicator-track') as HTMLElement;
    const thumb = container.querySelector('.chat-scroll-indicator') as HTMLElement;
    expect(thumb.style.opacity).toBe('1');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      top: 0, right: 10, bottom: 800, left: 0, width: 10, height: 800, x: 0, y: 0, toJSON: () => ({}),
    });
    vi.spyOn(thumb, 'getBoundingClientRect').mockReturnValue({
      top: 0, right: 5, bottom: 24, left: 0, width: 5, height: 24, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.pointerDown(thumb, { clientY: 10 });
    await waitFor(() => {
      expect(track.className).toContain('is-dragging');
    });
    fireEvent.pointerMove(window, { clientY: 400 });

    expect(second.scrollTop).not.toBe(0);
    expect(first.scrollTop).toBe(0);
  });
});
