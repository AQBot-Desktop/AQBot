function formatCompact(value: number, divisor: number, suffix: string): string {
  const compact = Math.round((value / divisor) * 10) / 10;
  const formatted = Number.isInteger(compact) ? compact.toFixed(0) : compact.toFixed(1);
  return `${formatted}${suffix}`;
}

export function formatTokenCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return formatCompact(value, 1_000_000, 'm');
  if (abs >= 1_000) return formatCompact(value, 1_000, 'k');
  return value.toLocaleString();
}
