import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverflowIconToolbar } from '../OverflowIconToolbar';

const items = [
  { key: 'a', node: <button type="button">A</button>, overflowLabel: 'Action A' },
  { key: 'b', node: <button type="button">B</button>, overflowLabel: 'Action B' },
  { key: 'c', node: <button type="button">C</button>, overflowLabel: 'Action C' },
  { key: 'd', node: <button type="button">D</button>, overflowLabel: 'Action D' },
  { key: 'e', node: <button type="button">E</button>, overflowLabel: 'Action E' },
];

describe('OverflowIconToolbar', () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  let toolbarWidth = 400;

  beforeEach(() => {
    toolbarWidth = 400;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        if ((this as HTMLElement).getAttribute('data-testid') === 'overflow-icon-toolbar') {
          return toolbarWidth;
        }
        return originalClientWidth?.get?.call(this) ?? 0;
      },
    });
    vi.stubGlobal('ResizeObserver', class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    }
    vi.unstubAllGlobals();
  });

  it('keeps all actions visible when the row is wide enough', () => {
    render(<OverflowIconToolbar moreLabel="more" items={items} />);

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('E')).toBeInTheDocument();
    expect(screen.queryByTestId('overflow-icon-toolbar-more')).not.toBeInTheDocument();
  });

  it('moves trailing actions into a more dropdown when the row is narrow', () => {
    toolbarWidth = 90;
    render(<OverflowIconToolbar moreLabel="more" items={items} />);

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByTestId('overflow-icon-toolbar-more')).toBeInTheDocument();
    expect(screen.queryByText('E')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('overflow-icon-toolbar-more'));
    expect(screen.getByTestId('overflow-icon-toolbar-menu')).toBeInTheDocument();
    expect(screen.getByText('Action E')).toBeInTheDocument();
  });
});
