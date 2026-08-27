import type { RoleOpeningQuestion } from '@/types';

export type { RoleOpeningQuestion };

export const OPENING_QUESTION_TITLE_MAX_CHARS = 80;

export interface OpeningQuestionDraft {
  title: string;
  content: string;
}

export type OpeningQuestionNormalizeErrorCode =
  | 'contentRequired'
  | 'titleTooLong'
  | 'titleHasNewline';

export type NormalizeOpeningQuestionsResult =
  | { ok: true; items: RoleOpeningQuestion[] }
  | { ok: false; code: OpeningQuestionNormalizeErrorCode; index: number };

export interface StoredOpeningQuestions {
  openingQuestions?: unknown;
  openingQuestionItems?: unknown;
}

export type DecodeStoredOpeningQuestionsResult =
  | {
      ok: true;
      items: RoleOpeningQuestion[];
      usedLegacyFallback?: true;
      recoveredFromV2?: true;
    }
  | { ok: false };

type ParsedField<T> =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ok'; value: T };

function hasNewline(value: string): boolean {
  return value.includes('\n') || value.includes('\r');
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function trimTitle(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const title = value.trim();
  return title.length > 0 ? title : null;
}

export function parseOpeningQuestion(value: unknown): RoleOpeningQuestion | null {
  if (typeof value === 'string') {
    return { title: null, content: value };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as { title?: unknown; content?: unknown };
  if (typeof record.content !== 'string') {
    return null;
  }
  const title = trimTitle(record.title);
  if (title === undefined) {
    return null;
  }
  return { title, content: record.content };
}

export function parseOpeningQuestionList(value: unknown): RoleOpeningQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const items: RoleOpeningQuestion[] = [];
  for (const entry of value) {
    const parsed = parseOpeningQuestion(entry);
    if (!parsed) return null;
    items.push(parsed);
  }
  return items;
}

export function normalizeOpeningQuestions(
  drafts: OpeningQuestionDraft[],
): NormalizeOpeningQuestionsResult {
  const items: RoleOpeningQuestion[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const title = drafts[index].title.trim();
    const content = drafts[index].content.replace(/^\s+|\s+$/g, '');
    if (!title && !content) {
      continue;
    }
    if (hasNewline(title)) {
      return { ok: false, code: 'titleHasNewline', index };
    }
    if (charCount(title) > OPENING_QUESTION_TITLE_MAX_CHARS) {
      return { ok: false, code: 'titleTooLong', index };
    }
    if (!content) {
      return { ok: false, code: 'contentRequired', index };
    }
    items.push({
      title: title.length > 0 ? title : null,
      content,
    });
  }
  return { ok: true, items };
}

export function openingQuestionLabel(question: RoleOpeningQuestion): string {
  const title = question.title?.trim();
  if (title) return title;
  return question.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
}

export function encodeStoredOpeningQuestions(items: RoleOpeningQuestion[]): {
  openingQuestions: string[];
  openingQuestionItems: RoleOpeningQuestion[];
} {
  return {
    openingQuestions: items.map((item) => item.content),
    openingQuestionItems: items.map((item) => ({
      title: item.title,
      content: item.content,
    })),
  };
}

function parseLegacyContents(value: unknown): ParsedField<string[]> {
  if (value === undefined) return { kind: 'absent' };
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', value };
}

function parseV2Items(value: unknown): ParsedField<RoleOpeningQuestion[]> {
  if (value === undefined) return { kind: 'absent' };
  const parsed = parseOpeningQuestionList(value);
  return parsed ? { kind: 'ok', value: parsed } : { kind: 'invalid' };
}

function untitledFromContents(contents: string[]): RoleOpeningQuestion[] {
  return contents.map((content) => ({ title: null, content }));
}

function contentsOf(items: RoleOpeningQuestion[]): string[] {
  return items.map((item) => item.content);
}

export function decodeStoredOpeningQuestions(
  stored: StoredOpeningQuestions,
): DecodeStoredOpeningQuestionsResult {
  const legacy = parseLegacyContents(stored.openingQuestions);
  const v2 = parseV2Items(stored.openingQuestionItems);

  if (v2.kind === 'ok') {
    if (legacy.kind === 'ok') {
      if (contentsEqual(contentsOf(v2.value), legacy.value)) {
        return { ok: true, items: v2.value };
      }
      return {
        ok: true,
        items: untitledFromContents(legacy.value),
        usedLegacyFallback: true,
      };
    }
    return {
      ok: true,
      items: v2.value,
      ...(legacy.kind === 'invalid' ? { recoveredFromV2: true as const } : {}),
    };
  }

  if (legacy.kind === 'ok') {
    return {
      ok: true,
      items: untitledFromContents(legacy.value),
      ...(v2.kind === 'invalid' ? { usedLegacyFallback: true as const } : {}),
    };
  }

  if (legacy.kind === 'absent' && v2.kind === 'absent') {
    return { ok: true, items: [] };
  }

  return { ok: false };
}

function contentsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}
