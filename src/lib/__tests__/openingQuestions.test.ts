import { describe, expect, it } from 'vitest';
import {
  OPENING_QUESTION_TITLE_MAX_CHARS,
  decodeStoredOpeningQuestions,
  encodeStoredOpeningQuestions,
  normalizeOpeningQuestions,
  openingQuestionLabel,
  parseOpeningQuestion,
  parseOpeningQuestionList,
} from '../openingQuestions';

describe('parseOpeningQuestion', () => {
  it('maps a legacy string to an untitled question', () => {
    expect(parseOpeningQuestion('翻译这段话')).toEqual({
      title: null,
      content: '翻译这段话',
    });
  });

  it('accepts a structured object and treats empty title as null', () => {
    expect(parseOpeningQuestion({ title: '  ', content: 'hello\nworld' })).toEqual({
      title: null,
      content: 'hello\nworld',
    });
    expect(parseOpeningQuestion({ title: '摘要', content: '完整正文' })).toEqual({
      title: '摘要',
      content: '完整正文',
    });
  });

  it('rejects invalid values', () => {
    expect(parseOpeningQuestion(null)).toBeNull();
    expect(parseOpeningQuestion(1)).toBeNull();
    expect(parseOpeningQuestion({ content: 1 })).toBeNull();
  });
});

describe('parseOpeningQuestionList', () => {
  it('parses mixed legacy strings and objects', () => {
    expect(parseOpeningQuestionList([
      '旧问题',
      { title: '标题', content: '正文' },
    ])).toEqual([
      { title: null, content: '旧问题' },
      { title: '标题', content: '正文' },
    ]);
  });

  it('returns null when the list is not recoverable', () => {
    expect(parseOpeningQuestionList('nope')).toBeNull();
    expect(parseOpeningQuestionList([{ title: 't' }])).toBeNull();
  });
});

describe('normalizeOpeningQuestions', () => {
  it('drops fully blank items and keeps internal newlines', () => {
    const result = normalizeOpeningQuestions([
      { title: '', content: '  ' },
      { title: '  翻译  ', content: '  第一行\n第二行  ' },
    ]);
    expect(result).toEqual({
      ok: true,
      items: [{ title: '翻译', content: '第一行\n第二行' }],
    });
  });

  it('preserves order and duplicate contents', () => {
    const result = normalizeOpeningQuestions([
      { title: '', content: '重复' },
      { title: 'A', content: '重复' },
    ]);
    expect(result).toEqual({
      ok: true,
      items: [
        { title: null, content: '重复' },
        { title: 'A', content: '重复' },
      ],
    });
  });

  it('rejects a title without content', () => {
    expect(normalizeOpeningQuestions([{ title: '只有标题', content: '  ' }])).toEqual({
      ok: false,
      code: 'contentRequired',
      index: 0,
    });
  });

  it('rejects titles that contain newlines or exceed the character limit', () => {
    expect(normalizeOpeningQuestions([{ title: '第一行\n第二行', content: '正文' }])).toEqual({
      ok: false,
      code: 'titleHasNewline',
      index: 0,
    });
    const longTitle = '字'.repeat(OPENING_QUESTION_TITLE_MAX_CHARS + 1);
    expect(normalizeOpeningQuestions([{ title: longTitle, content: '正文' }])).toEqual({
      ok: false,
      code: 'titleTooLong',
      index: 0,
    });
  });
});

describe('openingQuestionLabel', () => {
  it('prefers the title and otherwise uses the first non-empty content line', () => {
    expect(openingQuestionLabel({ title: '短标题', content: '很长的正文' })).toBe('短标题');
    expect(openingQuestionLabel({
      title: null,
      content: '\n  第一行有效内容  \n第二行',
    })).toBe('第一行有效内容');
  });
});

describe('stored opening question snapshots', () => {
  it('dual-writes content strings and structured items', () => {
    expect(encodeStoredOpeningQuestions([
      { title: '翻译', content: '请翻译\n这段话' },
    ])).toEqual({
      openingQuestions: ['请翻译\n这段话'],
      openingQuestionItems: [{ title: '翻译', content: '请翻译\n这段话' }],
    });
  });

  it('keeps titles when the v2 content projection matches the legacy strings', () => {
    expect(decodeStoredOpeningQuestions({
      openingQuestions: ['请翻译\n这段话'],
      openingQuestionItems: [{ title: '翻译', content: '请翻译\n这段话' }],
    })).toEqual({
      ok: true,
      items: [{ title: '翻译', content: '请翻译\n这段话' }],
    });
  });

  it('maps a legacy snapshot without v2 items to untitled questions', () => {
    expect(decodeStoredOpeningQuestions({
      openingQuestions: ['旧问题'],
    })).toEqual({
      ok: true,
      items: [{ title: null, content: '旧问题' }],
    });
  });

  it('discards stale titles when an older writer changed the content mirror', () => {
    expect(decodeStoredOpeningQuestions({
      openingQuestions: ['旧版本改过的正文'],
      openingQuestionItems: [{ title: '过期标题', content: '新版本正文' }],
    })).toEqual({
      ok: true,
      items: [{ title: null, content: '旧版本改过的正文' }],
      usedLegacyFallback: true,
    });
  });

  it('recovers from v2 when the legacy column is unreadable', () => {
    expect(decodeStoredOpeningQuestions({
      openingQuestions: { not: 'an array' },
      openingQuestionItems: [{ title: '标题', content: '正文' }],
    })).toEqual({
      ok: true,
      items: [{ title: '标题', content: '正文' }],
      recoveredFromV2: true,
    });
  });

  it('fails when both stored forms are invalid', () => {
    expect(decodeStoredOpeningQuestions({
      openingQuestions: 'nope',
      openingQuestionItems: [{ title: '缺正文' }],
    })).toEqual({ ok: false });
  });
});
