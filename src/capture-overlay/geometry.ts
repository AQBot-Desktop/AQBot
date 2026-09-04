export type Point = { x: number; y: number };
export type PixelRegion = { x: number; y: number; width: number; height: number };

export function pixelRegion(
  start: Point,
  end: Point,
  { viewport, image }: {
    viewport: { width: number; height: number };
    image: { width: number; height: number };
  },
): PixelRegion | null {
  if (![start.x, start.y, end.x, end.y, viewport.width, viewport.height, image.width, image.height]
    .every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0
    || image.width <= 0 || image.height <= 0) return null;

  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const x = Math.floor(clamp(Math.min(start.x, end.x) / viewport.width, 1) * image.width);
  const y = Math.floor(clamp(Math.min(start.y, end.y) / viewport.height, 1) * image.height);
  const right = Math.ceil(clamp(Math.max(start.x, end.x) / viewport.width, 1) * image.width);
  const bottom = Math.ceil(clamp(Math.max(start.y, end.y) / viewport.height, 1) * image.height);
  if (right <= x || bottom <= y || start.x === end.x || start.y === end.y) return null;
  return { x, y, width: right - x, height: bottom - y };
}
