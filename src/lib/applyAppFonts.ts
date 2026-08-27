import {
  cssFontStack,
  DEFAULT_CODE_FONT_FALLBACK,
  DEFAULT_UI_FONT_FALLBACK,
} from '@/lib/cssFontFamily';
import {
  buildLocalFontFaceCss,
  normalizeFontStyle,
  type SystemFontFace,
} from '@/lib/systemFonts';

const UI_FONT_FACE_STYLE_ID = 'aqbot-ui-font-faces';
const CHAT_FONT_FACE_STYLE_ID = 'aqbot-chat-font-faces';

export interface ApplyAppFontsInput {
  fontFamily: string;
  fontWeight: number;
  fontStyle?: string;
  fontFaces?: SystemFontFace[];
  codeFontFamily: string;
  chatFontFamily: string;
  chatFontWeight: number;
  chatFontStyle?: string;
  chatFontFaces?: SystemFontFace[];
  chatFontSize: number;
  chatLineHeight: number;
}

function upsertStyleTag(id: string, css: string) {
  const existing = document.getElementById(id);
  if (!css) {
    existing?.remove();
    return;
  }
  let element = existing as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement('style');
    element.id = id;
    document.head.appendChild(element);
  }
  element.textContent = css;
}

export function applyAppFonts(input: ApplyAppFontsInput) {
  const root = document.documentElement;
  const fontStyle = normalizeFontStyle(input.fontStyle);
  const chatFontStyle = normalizeFontStyle(input.chatFontStyle);

  root.style.setProperty('--font-weight', String(input.fontWeight));
  root.style.setProperty('--font-style', fontStyle);
  if (input.fontFamily) {
    root.style.setProperty('--font-family', cssFontStack(input.fontFamily, DEFAULT_UI_FONT_FALLBACK));
  } else {
    root.style.removeProperty('--font-family');
  }

  if (input.codeFontFamily) {
    root.style.setProperty(
      '--code-font-family',
      cssFontStack(input.codeFontFamily, DEFAULT_CODE_FONT_FALLBACK),
    );
  } else {
    root.style.removeProperty('--code-font-family');
  }

  root.style.setProperty('--chat-font-size', `${input.chatFontSize ?? 15}px`);
  root.style.setProperty('--chat-line-height', String(input.chatLineHeight ?? 1.7));
  root.style.setProperty('--chat-font-weight', String(input.chatFontWeight ?? 400));
  root.style.setProperty('--chat-font-style', chatFontStyle);
  root.style.setProperty(
    '--chat-font-family',
    input.chatFontFamily
      ? cssFontStack(input.chatFontFamily, DEFAULT_UI_FONT_FALLBACK)
      : DEFAULT_UI_FONT_FALLBACK,
  );

  upsertStyleTag(
    UI_FONT_FACE_STYLE_ID,
    input.fontFamily ? buildLocalFontFaceCss(input.fontFamily, input.fontFaces ?? []) : '',
  );
  upsertStyleTag(
    CHAT_FONT_FACE_STYLE_ID,
    input.chatFontFamily ? buildLocalFontFaceCss(input.chatFontFamily, input.chatFontFaces ?? []) : '',
  );
}
