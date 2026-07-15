import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearHtmlRenderCache,
  getHtmlRenderCacheStats,
  HtmlRenderNode,
} from '../HtmlRenderNode';

describe('HtmlRenderNode', () => {
  afterEach(() => {
    clearHtmlRenderCache();
    vi.restoreAllMocks();
  });

  it('renders sanitized html directly', () => {
    render(
      <HtmlRenderNode
        node={{
          type: 'html-render',
          raw: '<html-render><div style="color:red" onclick="bad()">safe</div><script>alert(1)</script></html-render>',
          content: '<div style="color:red" onclick="bad()">safe</div><script>alert(1)</script>',
        }}
      />,
    );

    const content = screen.getByTestId('html-render-content');
    expect(content.innerHTML).toContain('style="color:red"');
    expect(content.innerHTML).toContain('safe');
    expect(content.innerHTML).not.toContain('onclick');
    expect(content.innerHTML).not.toContain('<script');
  });

  it('removes unsafe urls from rendered links', () => {
    render(
      <HtmlRenderNode
        node={{
          type: 'html-render',
          raw: '<html-render><a href="javascript:alert(1)">bad</a></html-render>',
          content: '<a href="javascript:alert(1)">bad</a>',
        }}
      />,
    );

    const link = screen.getByText('bad');
    expect(link).not.toHaveAttribute('href');
  });

  it('does not render display chrome around the html fragment', () => {
    render(
      <HtmlRenderNode
        node={{
          type: 'html-render',
          raw: '<html-render><section><h1>Title</h1></section></html-render>',
          content: '<section><h1>Title</h1></section>',
        }}
      />,
    );

    const content = screen.getByTestId('html-render-content');
    expect(content).toHaveTextContent('Title');
    expect(screen.queryByText('HTML Render')).toBeNull();
    expect(screen.queryByRole('button', { name: '预览' })).toBeNull();
    expect(screen.queryByRole('button', { name: '源码' })).toBeNull();
  });

  it('coalesces streaming html updates until the next animation frame', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const { rerender } = render(
      <HtmlRenderNode
        node={{
          type: 'html-render',
          loading: true,
          content: '<div>first</div>',
        }}
      />,
    );

    expect(screen.getByTestId('html-render-content')).toHaveTextContent('first');

    rerender(
      <HtmlRenderNode
        node={{
          type: 'html-render',
          loading: true,
          content: '<div>second</div>',
        }}
      />,
    );
    rerender(
      <HtmlRenderNode
        node={{
          type: 'html-render',
          loading: true,
          content: '<div>third</div>',
        }}
      />,
    );

    expect(screen.getByTestId('html-render-content')).toHaveTextContent('first');
    expect(frameCallbacks).toHaveLength(1);

    act(() => {
      frameCallbacks[0]?.(16);
    });

    expect(screen.getByTestId('html-render-content')).toHaveTextContent('third');
  });

  it('renders final html updates immediately without waiting for animation frame', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const { rerender } = render(
      <HtmlRenderNode
        node={{
          type: 'html-render',
          loading: true,
          content: '<div>draft</div>',
        }}
      />,
    );

    rerender(
      <HtmlRenderNode
        node={{
          type: 'html-render',
          loading: false,
          content: '<div>final</div>',
        }}
      />,
    );

    expect(screen.getByTestId('html-render-content')).toHaveTextContent('final');
  });

  it('adapts common light inline colors for dark mode', () => {
    render(
      <HtmlRenderNode
        {...({
          isDark: true,
          node: {
            type: 'html-render',
            content: '<div style="color:#111;background:#fff;border:1px solid #eee">dark friendly</div>',
          },
        } as any)}
      />,
    );

    const content = screen.getByTestId('html-render-content');
    expect(content).toHaveStyle({ colorScheme: 'dark' });
    expect(content.innerHTML).toContain('var(--aqbot-html-fg)');
    expect(content.innerHTML).toContain('rgba(255,255,255,0.06)');
    expect(content.innerHTML).toContain('rgba(255,255,255,0.18)');
  });

  it('removes style tags from html render fragments', () => {
    render(
      <HtmlRenderNode
        node={{
          type: 'html-render',
          content: '<style>.x{color:red}</style><div>safe</div>',
        }}
      />,
    );

    const content = screen.getByTestId('html-render-content');
    expect(content).toHaveTextContent('safe');
    expect(content.innerHTML).not.toContain('<style');
  });

  it('bounds cached html by entry count and estimated bytes without retaining source in keys', () => {
    const makeHtml = (index: number) => `<div data-index="${index}">${'x'.repeat(128 * 1024)}</div>`;
    const { rerender } = render(
      <HtmlRenderNode node={{ type: 'html-render', content: makeHtml(0) }} />,
    );

    for (let index = 1; index < 90; index += 1) {
      rerender(<HtmlRenderNode node={{ type: 'html-render', content: makeHtml(index) }} />);
    }

    const stats = getHtmlRenderCacheStats();
    expect(stats.entries).toBeLessThanOrEqual(80);
    expect(stats.estimatedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(stats.maxKeyLength).toBeLessThan(64);
  });
});
