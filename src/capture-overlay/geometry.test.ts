import { describe, expect, it } from 'vitest';
import { pixelRegion } from './geometry';

describe('screenshot pixel coordinates', () => {
  it('uses actual image/CSS ratios for mixed-DPI displays and reverse drags', () => {
    expect(pixelRegion({ x: 400, y: 300 }, { x: 100, y: 100 },
      { viewport: { width: 1280, height: 720 }, image: { width: 1920, height: 1080 } }))
      .toEqual({ x: 150, y: 150, width: 450, height: 300 });
  });

  it('clamps selection to the captured monitor without losing edge pixels', () => {
    expect(pixelRegion({ x: -10, y: -10 }, { x: 9999, y: 9999 },
      { viewport: { width: 100, height: 80 }, image: { width: 200, height: 160 } }))
      .toEqual({ x: 0, y: 0, width: 200, height: 160 });
    expect(pixelRegion({ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.6 },
      { viewport: { width: 100, height: 80 }, image: { width: 200, height: 160 } }))
      .toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });

  it('rejects empty and non-finite rectangles', () => {
    const viewport = { width: 100, height: 100 };
    expect(pixelRegion({ x: 2, y: 2 }, { x: 2, y: 50 }, { viewport, image: viewport })).toBeNull();
    expect(pixelRegion({ x: NaN, y: 2 }, { x: 50, y: 50 }, { viewport, image: viewport })).toBeNull();
    expect(pixelRegion({ x: 2, y: 2 }, { x: 50, y: 50 }, { viewport: { width: 0, height: 100 }, image: viewport })).toBeNull();
  });
});
