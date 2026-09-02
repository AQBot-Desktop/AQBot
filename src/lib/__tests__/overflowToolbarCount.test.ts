import { describe, expect, it } from 'vitest';
import { countVisibleToolbarItems } from '../overflowToolbarCount';

describe('countVisibleToolbarItems', () => {
  it('shows every item when width is unknown or enough', () => {
    expect(countVisibleToolbarItems({ availableWidth: 0, itemCount: 7 })).toBe(7);
    expect(countVisibleToolbarItems({ availableWidth: 400, itemCount: 7 })).toBe(7);
  });

  it('keeps a more button and hides trailing items when the row is too narrow', () => {
    expect(countVisibleToolbarItems({
      availableWidth: 90,
      itemCount: 7,
      itemWidth: 28,
      gap: 2,
      moreWidth: 28,
    })).toBe(2);
    expect(countVisibleToolbarItems({
      availableWidth: 28,
      itemCount: 7,
      itemWidth: 28,
      gap: 2,
      moreWidth: 28,
    })).toBe(0);
  });
});
