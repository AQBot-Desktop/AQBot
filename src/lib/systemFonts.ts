import { invoke, isTauri } from '@/lib/invoke';
import { quoteCssFontFamily } from '@/lib/cssFontFamily';

export type CssFontStyle = 'normal' | 'italic' | 'oblique';

export interface SystemFontFace {
  name: string;
  weight: number;
  style: CssFontStyle;
  local_names: string[];
}

export const GENERIC_CSS_FONT_FACES: SystemFontFace[] = [
  { name: 'thin', weight: 100, style: 'normal', local_names: [] },
  { name: 'extraLight', weight: 200, style: 'normal', local_names: [] },
  { name: 'light', weight: 300, style: 'normal', local_names: [] },
  { name: 'regular', weight: 400, style: 'normal', local_names: [] },
  { name: 'medium', weight: 500, style: 'normal', local_names: [] },
  { name: 'semiBold', weight: 600, style: 'normal', local_names: [] },
  { name: 'bold', weight: 700, style: 'normal', local_names: [] },
  { name: 'extraBold', weight: 800, style: 'normal', local_names: [] },
  { name: 'black', weight: 900, style: 'normal', local_names: [] },
];

export const GENERIC_FACE_LABEL_KEYS: Record<string, string> = {
  thin: 'settings.fontFaceThin',
  extraLight: 'settings.fontFaceExtraLight',
  light: 'settings.fontFaceLight',
  regular: 'settings.fontFaceRegular',
  medium: 'settings.fontFaceMedium',
  semiBold: 'settings.fontFaceSemiBold',
  bold: 'settings.fontFaceBold',
  extraBold: 'settings.fontFaceExtraBold',
  black: 'settings.fontFaceBlack',
};

const faceCache = new Map<string, SystemFontFace[]>();
const faceInflight = new Map<string, Promise<SystemFontFace[]>>();

export function normalizeFontStyle(value: unknown): CssFontStyle {
  if (value === 'italic' || value === 'oblique') return value;
  return 'normal';
}

export function clampFontWeight(value: number): number {
  if (!Number.isFinite(value)) return 400;
  return Math.min(900, Math.max(100, Math.round(value)));
}

export function fontFaceValue(face: Pick<SystemFontFace, 'name' | 'weight' | 'style'>): string {
  return `${face.name}@@${face.weight}@@${face.style}`;
}

export function parseFontFaceValue(
  value: string,
): { name: string; weight: number; style: CssFontStyle } | null {
  const parts = value.split('@@');
  if (parts.length !== 3) return null;
  const weight = Number(parts[1]);
  if (!Number.isFinite(weight)) return null;
  return {
    name: parts[0],
    weight: clampFontWeight(weight),
    style: normalizeFontStyle(parts[2]),
  };
}

export function isSystemFontFace(value: unknown): value is SystemFontFace {
  if (!value || typeof value !== 'object') return false;
  const face = value as Record<string, unknown>;
  return typeof face.name === 'string'
    && typeof face.weight === 'number'
    && Number.isFinite(face.weight)
    && typeof face.style === 'string'
    && Array.isArray(face.local_names)
    && face.local_names.every((name) => typeof name === 'string');
}

export function parseSystemFontFaces(value: unknown): SystemFontFace[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSystemFontFace).map((face) => ({
    name: face.name.trim() || fallbackFaceName(face.weight, face.style),
    weight: clampFontWeight(face.weight),
    style: normalizeFontStyle(face.style),
    local_names: [...new Set(face.local_names.map((name) => name.trim()).filter(Boolean))],
  }));
}

export function matchFontFace(
  faces: SystemFontFace[],
  weight: number,
  style: string,
): SystemFontFace | undefined {
  if (faces.length === 0) return undefined;
  const normalizedStyle = normalizeFontStyle(style);
  const clampedWeight = clampFontWeight(weight);
  const exact = faces.find((face) => face.weight === clampedWeight && face.style === normalizedStyle);
  if (exact) return exact;
  const sameStyle = faces.filter((face) => face.style === normalizedStyle);
  const pool = sameStyle.length > 0 ? sameStyle : faces;
  return pool.reduce((best, face) => (
    Math.abs(face.weight - clampedWeight) < Math.abs(best.weight - clampedWeight) ? face : best
  ));
}

export function resolvePickerFaces(faces: SystemFontFace[]): SystemFontFace[] {
  return faces.length > 0 ? faces : GENERIC_CSS_FONT_FACES;
}

export function genericFaceLabelKey(name: string): string | undefined {
  return GENERIC_FACE_LABEL_KEYS[name];
}

export function buildLocalFontFaceCss(family: string, faces: SystemFontFace[]): string {
  const quotedFamily = quoteCssFontFamily(family);
  if (!quotedFamily) return '';
  return faces
    .filter((face) => face.local_names.length > 0)
    .map((face) => {
      const src = face.local_names
        .map((name) => `local(${quoteCssFontFamily(name)})`)
        .join(', ');
      return [
        '@font-face {',
        `  font-family: ${quotedFamily};`,
        `  src: ${src};`,
        `  font-weight: ${face.weight};`,
        `  font-style: ${face.style};`,
        '}',
      ].join('\n');
    })
    .join('\n');
}

const EMPTY_FONT_FACES: SystemFontFace[] = [];

export function peekSystemFontFaces(family: string): SystemFontFace[] | undefined {
  const key = family.trim();
  if (!key) return EMPTY_FONT_FACES;
  return faceCache.get(key);
}

export function loadSystemFontFaces(family: string): Promise<SystemFontFace[]> {
  const key = family.trim();
  if (!key) return Promise.resolve([]);
  const cached = faceCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inflight = faceInflight.get(key);
  if (inflight) return inflight;

  const promise = (!isTauri()
    ? Promise.resolve([])
    : invoke<unknown>('list_system_font_faces', { family: key }))
    .then(parseSystemFontFaces)
    .catch(() => [] as SystemFontFace[])
    .then((faces) => {
      faceCache.set(key, faces);
      faceInflight.delete(key);
      return faces;
    });

  faceInflight.set(key, promise);
  return promise;
}

export function clearSystemFontFaceCache() {
  faceCache.clear();
  faceInflight.clear();
}

function fallbackFaceName(weight: number, style: string): string {
  const matched = GENERIC_CSS_FONT_FACES.find((face) => face.weight === clampFontWeight(weight));
  const base = matched?.name ?? 'regular';
  if (style === 'italic' || style === 'oblique') return `${base}-${style}`;
  return base;
}
