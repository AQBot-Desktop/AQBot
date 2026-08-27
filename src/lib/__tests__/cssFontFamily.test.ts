import { describe, expect, it } from 'vitest';
import {
  cssFontStack,
  DEFAULT_UI_FONT_FALLBACK,
  quoteCssFontFamily,
} from '../cssFontFamily';

describe('quoteCssFontFamily', () => {
  it('quotes families that contain digits or spaces so CSS can parse them', () => {
    expect(quoteCssFontFamily('Alibaba PuHuiTi 3.0')).toBe('"Alibaba PuHuiTi 3.0"');
  });

  it('quotes ordinary named families to avoid identifier edge cases', () => {
    expect(quoteCssFontFamily('Inter')).toBe('"Inter"');
    expect(quoteCssFontFamily('Academy Engraved LET')).toBe('"Academy Engraved LET"');
  });

  it('leaves generic families unquoted', () => {
    expect(quoteCssFontFamily('sans-serif')).toBe('sans-serif');
    expect(quoteCssFontFamily('ui-monospace')).toBe('ui-monospace');
  });

  it('is idempotent for already-quoted names', () => {
    expect(quoteCssFontFamily('"Alibaba PuHuiTi 3.0"')).toBe('"Alibaba PuHuiTi 3.0"');
  });

  it('quotes each family in a stack', () => {
    expect(quoteCssFontFamily('Alibaba PuHuiTi 3.0, Inter, sans-serif')).toBe(
      '"Alibaba PuHuiTi 3.0", "Inter", sans-serif',
    );
  });

  it('returns an empty string for blank input', () => {
    expect(quoteCssFontFamily('   ')).toBe('');
  });
});

describe('cssFontFamily CSSOM parsing', () => {
  it('rejects unquoted families with digits, and accepts the quoted form', () => {
    const element = document.createElement('div');
    element.style.fontFamily = 'Alibaba PuHuiTi 3.0';
    expect(element.style.fontFamily).not.toMatch(/Alibaba/);

    element.style.fontFamily = quoteCssFontFamily('Alibaba PuHuiTi 3.0');
    expect(element.style.fontFamily).toMatch(/Alibaba PuHuiTi 3\.0/);
  });
});

describe('cssFontStack', () => {
  it('appends fallbacks after a quoted named family', () => {
    expect(cssFontStack('Alibaba PuHuiTi 3.0', DEFAULT_UI_FONT_FALLBACK)).toBe(
      `"Alibaba PuHuiTi 3.0", ${DEFAULT_UI_FONT_FALLBACK}`,
    );
  });

  it('returns only the fallback when the family is empty', () => {
    expect(cssFontStack('', DEFAULT_UI_FONT_FALLBACK)).toBe(DEFAULT_UI_FONT_FALLBACK);
  });
});
