import { afterEach, describe, expect, it } from 'vitest';
import { applyAppFonts } from '../applyAppFonts';
import { DEFAULT_UI_FONT_FALLBACK } from '../cssFontFamily';

describe('applyAppFonts', () => {
  afterEach(() => {
    document.documentElement.style.cssText = '';
    document.getElementById('aqbot-ui-font-faces')?.remove();
    document.getElementById('aqbot-chat-font-faces')?.remove();
  });

  it('quotes families with digits so the CSS font-family property is valid', () => {
    applyAppFonts({
      fontFamily: 'Alibaba PuHuiTi 3.0',
      fontWeight: 500,
      fontStyle: 'normal',
      codeFontFamily: '',
      chatFontFamily: 'Alibaba PuHuiTi 3.0',
      chatFontWeight: 400,
      chatFontSize: 15,
      chatLineHeight: 1.7,
    });

    expect(document.documentElement.style.getPropertyValue('--font-family')).toBe(
      `"Alibaba PuHuiTi 3.0", ${DEFAULT_UI_FONT_FALLBACK}`,
    );
    expect(document.documentElement.style.getPropertyValue('--chat-font-family')).toBe(
      `"Alibaba PuHuiTi 3.0", ${DEFAULT_UI_FONT_FALLBACK}`,
    );
    expect(document.documentElement.style.getPropertyValue('--font-weight')).toBe('500');
  });

  it('injects @font-face local() rules for the selected family faces', () => {
    applyAppFonts({
      fontFamily: 'Alibaba PuHuiTi 3.0',
      fontWeight: 500,
      fontFaces: [
        {
          name: '55 Regular',
          weight: 400,
          style: 'normal',
          local_names: ['Alibaba PuHuiTi 3.0 55 Regular'],
        },
        {
          name: '65 Medium',
          weight: 500,
          style: 'normal',
          local_names: ['Alibaba PuHuiTi 3.0 65 Medium'],
        },
      ],
      codeFontFamily: '',
      chatFontFamily: '',
      chatFontWeight: 400,
      chatFontSize: 15,
      chatLineHeight: 1.7,
    });

    const css = document.getElementById('aqbot-ui-font-faces')?.textContent ?? '';
    expect(css).toContain('local("Alibaba PuHuiTi 3.0 65 Medium")');
    expect(css).toContain('font-weight: 500;');
  });

  it('clears custom interface font properties when the family is system default', () => {
    applyAppFonts({
      fontFamily: 'Inter',
      fontWeight: 400,
      codeFontFamily: '',
      chatFontFamily: '',
      chatFontWeight: 400,
      chatFontSize: 15,
      chatLineHeight: 1.7,
    });
    applyAppFonts({
      fontFamily: '',
      fontWeight: 400,
      codeFontFamily: '',
      chatFontFamily: '',
      chatFontWeight: 400,
      chatFontSize: 16,
      chatLineHeight: 1.8,
    });

    expect(document.documentElement.style.getPropertyValue('--font-family')).toBe('');
    expect(document.getElementById('aqbot-ui-font-faces')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--chat-font-family')).toBe(
      DEFAULT_UI_FONT_FALLBACK,
    );
  });
});
