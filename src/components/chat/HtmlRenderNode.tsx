import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { NodeComponentProps } from 'markstream-react';
import { sanitizeHtmlContent } from 'stream-markdown-parser';
import { getHtmlRenderInnerContent } from '@/lib/chatHtmlRender';
import { createChatContentFingerprint } from '@/lib/chatMarkdownCache';

type HtmlRenderNodeData = {
  type: 'html-render';
  content?: string;
  raw?: string;
  loading?: boolean;
};

type HtmlRenderNodeProps =
  | NodeComponentProps<HtmlRenderNodeData>
  | { node: HtmlRenderNodeData; isDark?: boolean; ctx?: { isDark?: boolean } };

const HTML_RENDER_CACHE_MAX_ENTRIES = 80;
const HTML_RENDER_CACHE_MAX_BYTES = 8 * 1024 * 1024;

interface HtmlRenderCacheEntry {
  value: string;
  estimatedBytes: number;
}

const htmlRenderCache = new Map<string, HtmlRenderCacheEntry>();
let htmlRenderCacheBytes = 0;
const STYLE_TAG_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const STYLE_ATTR_RE = /\sstyle=("([^"]*)"|'([^']*)')/gi;

type Rgb = {
  r: number;
  g: number;
  b: number;
};

function getIsDark(props: HtmlRenderNodeProps) {
  return Boolean(props.isDark ?? props.ctx?.isDark);
}

function stripStyleTags(html: string) {
  return html.replace(STYLE_TAG_RE, '');
}

function createHtmlRenderCacheKey(html: string, isDark: boolean) {
  return `${isDark ? 'dark' : 'light'}:${createChatContentFingerprint(html)}`;
}

function rememberCachedHtml(key: string, value: string) {
  const existing = htmlRenderCache.get(key);
  if (existing) htmlRenderCacheBytes -= existing.estimatedBytes;
  htmlRenderCache.delete(key);

  const estimatedBytes = (key.length + value.length) * 2;
  if (estimatedBytes > HTML_RENDER_CACHE_MAX_BYTES) return value;

  htmlRenderCache.set(key, { value, estimatedBytes });
  htmlRenderCacheBytes += estimatedBytes;
  while (
    htmlRenderCache.size > HTML_RENDER_CACHE_MAX_ENTRIES
    || htmlRenderCacheBytes > HTML_RENDER_CACHE_MAX_BYTES
  ) {
    const oldestKey = htmlRenderCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = htmlRenderCache.get(oldestKey);
    if (oldest) htmlRenderCacheBytes -= oldest.estimatedBytes;
    htmlRenderCache.delete(oldestKey);
  }
  return value;
}

export function clearHtmlRenderCache() {
  htmlRenderCache.clear();
  htmlRenderCacheBytes = 0;
}

export function getHtmlRenderCacheStats() {
  return {
    entries: htmlRenderCache.size,
    estimatedBytes: htmlRenderCacheBytes,
    maxKeyLength: Math.max(0, ...Array.from(htmlRenderCache.keys(), (key) => key.length)),
  };
}

function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) return null;
  const full = hex.length === 3
    ? hex.split('').map((ch) => `${ch}${ch}`).join('')
    : hex;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function parseRgbColor(value: string): Rgb | null {
  const match = value.trim().match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (!match) return null;
  return {
    r: Math.min(255, Number(match[1])),
    g: Math.min(255, Number(match[2])),
    b: Math.min(255, Number(match[3])),
  };
}

function parseColor(value: string): Rgb | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'white') return { r: 255, g: 255, b: 255 };
  if (normalized === 'black') return { r: 0, g: 0, b: 0 };
  if (normalized === 'whitesmoke') return { r: 245, g: 245, b: 245 };
  if (normalized === 'gainsboro') return { r: 220, g: 220, b: 220 };
  if (normalized === 'lightgray' || normalized === 'lightgrey') return { r: 211, g: 211, b: 211 };
  return parseHexColor(normalized) ?? parseRgbColor(normalized);
}

function luminance(color: Rgb) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function isNeutral(color: Rgb) {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 32;
}

function isLightNeutral(value: string) {
  const color = parseColor(value);
  return Boolean(color && isNeutral(color) && luminance(color) >= 0.72);
}

function isDarkNeutral(value: string) {
  const color = parseColor(value);
  return Boolean(color && isNeutral(color) && luminance(color) <= 0.18);
}

function replaceNeutralColors(value: string, replacement: string) {
  return value.replace(/#[0-9a-f]{3,6}\b|rgba?\([^)]+\)|\b(?:white|whitesmoke|gainsboro|lightgr[ae]y|black)\b/gi, (match) => (
    isLightNeutral(match) || isDarkNeutral(match) ? replacement : match
  ));
}

function adaptDarkStyle(style: string) {
  return style
    .split(';')
    .map((part) => {
      const separatorIndex = part.indexOf(':');
      if (separatorIndex === -1) return part.trim();

      const property = part.slice(0, separatorIndex).trim();
      const lowerProperty = property.toLowerCase();
      const value = part.slice(separatorIndex + 1).trim();
      if (!property || !value) return '';

      if (lowerProperty === 'color' && isDarkNeutral(value)) {
        return `${property}:var(--aqbot-html-fg)`;
      }
      if ((lowerProperty === 'background' || lowerProperty === 'background-color') && isLightNeutral(value)) {
        return `${property}:rgba(255,255,255,0.06)`;
      }
      if (lowerProperty.includes('border')) {
        return `${property}:${replaceNeutralColors(value, 'rgba(255,255,255,0.18)')}`;
      }

      return `${property}:${value}`;
    })
    .filter(Boolean)
    .join(';');
}

function escapeStyleAttribute(value: string, quote: '"' | "'") {
  return quote === '"'
    ? value.replace(/"/g, '&quot;')
    : value.replace(/'/g, '&#39;');
}

function adaptHtmlForDarkMode(html: string) {
  return html.replace(STYLE_ATTR_RE, (_match, quoted: string, doubleQuoted?: string, singleQuoted?: string) => {
    const quote = quoted.startsWith('"') ? '"' : "'";
    const style = doubleQuoted ?? singleQuoted ?? '';
    return ` style=${quote}${escapeStyleAttribute(adaptDarkStyle(style), quote)}${quote}`;
  });
}

function renderSafeHtml(html: string, isDark: boolean) {
  const key = createHtmlRenderCacheKey(html, isDark);
  const cached = htmlRenderCache.get(key);
  if (cached != null) {
    htmlRenderCache.delete(key);
    htmlRenderCache.set(key, cached);
    return cached.value;
  }

  const sanitized = stripStyleTags(sanitizeHtmlContent(stripStyleTags(html)));
  const themed = isDark ? adaptHtmlForDarkMode(sanitized) : sanitized;
  return rememberCachedHtml(key, themed);
}

function createContainerStyle(isDark: boolean): CSSProperties & Record<string, string> {
  return {
    maxWidth: '100%',
    overflow: 'auto',
    contain: 'layout paint style',
    colorScheme: isDark ? 'dark' : 'light',
    '--aqbot-html-fg': isDark ? '#f5f5f5' : 'inherit',
    '--aqbot-html-bg': isDark ? 'rgba(255,255,255,0.06)' : 'transparent',
    '--aqbot-html-muted': isDark ? 'rgba(255,255,255,0.62)' : 'rgba(0,0,0,0.58)',
    '--aqbot-html-border': isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)',
    '--aqbot-html-accent': isDark ? '#8ab4f8' : '#1677ff',
    color: 'var(--aqbot-html-fg)',
    background: 'transparent',
  };
}

function getNode(props: HtmlRenderNodeProps) {
  return props.node;
}

export function HtmlRenderNode(props: HtmlRenderNodeProps) {
  const node = getNode(props);
  const isDark = getIsDark(props);
  const isLoading = Boolean(node.loading);
  const html = useMemo(() => getHtmlRenderInnerContent(node), [node]);
  const renderKey = createHtmlRenderCacheKey(html, isDark);
  const [safeHtml, setSafeHtml] = useState(() => renderSafeHtml(html, isDark));
  const latestRenderRef = useRef({ html, isDark, key: renderKey });
  const renderedKeyRef = useRef(renderKey);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    latestRenderRef.current = { html, isDark, key: renderKey };

    const cancelPendingFrame = () => {
      if (frameRef.current !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = null;
    };

    if (!isLoading) {
      cancelPendingFrame();
      if (renderedKeyRef.current !== renderKey) {
        renderedKeyRef.current = renderKey;
        setSafeHtml(renderSafeHtml(html, isDark));
      }
      return;
    }

    if (renderedKeyRef.current === renderKey || frameRef.current !== null) {
      return;
    }

    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      renderedKeyRef.current = renderKey;
      setSafeHtml(renderSafeHtml(html, isDark));
      return;
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const latest = latestRenderRef.current;
      renderedKeyRef.current = latest.key;
      setSafeHtml(renderSafeHtml(latest.html, latest.isDark));
    });
  }, [html, isDark, isLoading, renderKey]);

  useEffect(() => () => {
    if (frameRef.current !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(frameRef.current);
    }
  }, []);

  return (
    <div
      className="aqbot-html-render"
      data-testid="html-render-content"
      style={createContainerStyle(isDark)}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}

export default HtmlRenderNode;
