const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);

export const DEFAULT_UI_FONT_FALLBACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const DEFAULT_CODE_FONT_FALLBACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

function quoteSingleFontFamily(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
    || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed;
  }
  if (GENERIC_FONT_FAMILIES.has(trimmed.toLowerCase())) return trimmed;
  return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Quote a font family or stack so names like `Alibaba PuHuiTi 3.0` stay valid CSS. */
export function quoteCssFontFamily(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed
    .split(',')
    .map((part) => quoteSingleFontFamily(part))
    .filter(Boolean)
    .join(', ');
}

export function cssFontStack(family: string, fallback: string): string {
  const quoted = quoteCssFontFamily(family);
  if (!quoted) return fallback;
  return `${quoted}, ${fallback}`;
}
