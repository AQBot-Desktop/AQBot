import { describe, expect, it } from 'vitest';
import {
  buildLocalFontFaceCss,
  fontFaceValue,
  GENERIC_CSS_FONT_FACES,
  matchFontFace,
  parseFontFaceValue,
  parseSystemFontFaces,
  resolvePickerFaces,
} from '../systemFonts';

describe('parseSystemFontFaces', () => {
  it('keeps well-formed faces and drops invalid entries', () => {
    expect(parseSystemFontFaces([
      {
        name: '65 Medium',
        weight: 500,
        style: 'normal',
        local_names: ['Alibaba PuHuiTi 3.0 65 Medium', 'AlibabaPuHuiTi3.0-65-Medium'],
      },
      { name: 'nope' },
      'Inter',
    ])).toEqual([
      {
        name: '65 Medium',
        weight: 500,
        style: 'normal',
        local_names: ['Alibaba PuHuiTi 3.0 65 Medium', 'AlibabaPuHuiTi3.0-65-Medium'],
      },
    ]);
  });

  it('returns an empty list for a family-name array from the old command', () => {
    expect(parseSystemFontFaces(['Inter', 'JetBrains Mono'])).toEqual([]);
  });
});

describe('matchFontFace', () => {
  const faces = [
    {
      name: '55 Regular',
      weight: 400,
      style: 'normal' as const,
      local_names: ['Alibaba PuHuiTi 3.0 55 Regular'],
    },
    {
      name: '65 Medium',
      weight: 500,
      style: 'normal' as const,
      local_names: ['Alibaba PuHuiTi 3.0 65 Medium'],
    },
  ];

  it('matches the exact weight and style', () => {
    expect(matchFontFace(faces, 500, 'normal')?.name).toBe('65 Medium');
  });

  it('snaps to the closest available face', () => {
    expect(matchFontFace(faces, 700, 'normal')?.name).toBe('65 Medium');
    expect(matchFontFace(faces, 100, 'normal')?.name).toBe('55 Regular');
  });
});

describe('resolvePickerFaces', () => {
  it('falls back to generic CSS weights when a family has no faces yet', () => {
    expect(resolvePickerFaces([])).toEqual(GENERIC_CSS_FONT_FACES);
  });

  it('uses the system faces when they exist', () => {
    const faces = [{
      name: '55 Regular',
      weight: 400,
      style: 'normal' as const,
      local_names: [],
    }];
    expect(resolvePickerFaces(faces)).toEqual(faces);
  });
});

describe('fontFaceValue', () => {
  it('round-trips a face identity', () => {
    const value = fontFaceValue({ name: '65 Medium', weight: 500, style: 'normal' });
    expect(value).toBe('65 Medium@@500@@normal');
    expect(parseFontFaceValue(value)).toEqual({
      name: '65 Medium',
      weight: 500,
      style: 'normal',
    });
  });
});

describe('buildLocalFontFaceCss', () => {
  it('emits quoted local() sources so WebKit can pin a named face', () => {
    const css = buildLocalFontFaceCss('Alibaba PuHuiTi 3.0', [
      {
        name: '65 Medium',
        weight: 500,
        style: 'normal',
        local_names: ['Alibaba PuHuiTi 3.0 65 Medium', 'AlibabaPuHuiTi3.0-65-Medium'],
      },
    ]);
    expect(css).toContain('font-family: "Alibaba PuHuiTi 3.0";');
    expect(css).toContain('local("Alibaba PuHuiTi 3.0 65 Medium")');
    expect(css).toContain('local("AlibabaPuHuiTi3.0-65-Medium")');
    expect(css).toContain('font-weight: 500;');
  });
});
