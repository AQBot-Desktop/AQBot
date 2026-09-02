export const OVERFLOW_TOOLBAR_ITEM_WIDTH_PX = 28;
export const OVERFLOW_TOOLBAR_ITEM_GAP_PX = 2;
export const OVERFLOW_TOOLBAR_MORE_WIDTH_PX = 28;

export function countVisibleToolbarItems(options: {
  availableWidth: number;
  itemCount: number;
  itemWidth?: number;
  gap?: number;
  moreWidth?: number;
}): number {
  const itemWidth = options.itemWidth ?? OVERFLOW_TOOLBAR_ITEM_WIDTH_PX;
  const gap = options.gap ?? OVERFLOW_TOOLBAR_ITEM_GAP_PX;
  const moreWidth = options.moreWidth ?? OVERFLOW_TOOLBAR_MORE_WIDTH_PX;
  const { availableWidth, itemCount } = options;
  if (itemCount <= 0) return 0;
  if (availableWidth <= 0) return itemCount;

  const packedWidth = itemCount * itemWidth + Math.max(0, itemCount - 1) * gap;
  if (packedWidth <= availableWidth) return itemCount;

  for (let visible = itemCount - 1; visible >= 0; visible -= 1) {
    const used = visible * itemWidth
      + Math.max(0, visible - 1) * gap
      + (visible > 0 ? gap : 0)
      + moreWidth;
    if (used <= availableWidth) return visible;
  }
  return 0;
}
