import { describe, expect, it } from 'vitest';
import ar from '../locales/ar.json';
import de from '../locales/de.json';
import enUS from '../locales/en-US.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';
import hi from '../locales/hi.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import ru from '../locales/ru.json';
import zhCN from '../locales/zh-CN.json';
import zhTW from '../locales/zh-TW.json';

const locales = { ar, de, 'en-US': enUS, es, fr, hi, ja, ko, ru, 'zh-CN': zhCN, 'zh-TW': zhTW };

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value)
    .flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

describe('selection toolbar locales', () => {
  it('keeps the selection toolbar key set complete in all 11 locales', () => {
    const expected = leafKeys(enUS.settings.selectionToolbar);
    for (const [locale, translations] of Object.entries(locales)) {
      expect(leafKeys(translations.settings.selectionToolbar), locale).toEqual(expected);
    }
  });

  it('translates initial-composer and capture messages with consistent error placeholders', () => {
    const keys = [
      'textDirectSend', 'textDirectSendHint', 'screenshotDirectSend', 'screenshotDirectSendHint',
      'screenshotShortcut', 'screenshotShortcutHint', 'sourceText', 'additionalInstructions',
      'additionalInstructionsPlaceholder', 'sendInitial', 'screenshotPreview', 'sourceTextRequired',
      'visionRequired', 'captureInstructions', 'captureFailed', 'capturePermissionRequired',
      'captureUnavailable', 'captureBusy', 'captureInvalidRegion', 'captureExpired', 'captureTooLarge',
    ] as const;
    for (const [locale, translations] of Object.entries(locales)) {
      for (const key of keys) {
        const text = translations.settings.selectionToolbar[key];
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
        if (locale !== 'en-US') expect(text, `${locale}.${key}`).not.toBe(enUS.settings.selectionToolbar[key]);
      }
      expect(translations.settings.selectionToolbar.captureFailed).toContain('{{error}}');
    }
  });
});
