import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_INTRO_KEY, getRoleIntro, saveRoleIntro } from '../roleIntro';
import type { Role } from '@/types';

function makeRole(overrides: Partial<Pick<Role, 'opening_message' | 'opening_questions'>> = {}) {
  return {
    opening_message: '你好',
    opening_questions: [{ title: '翻译', content: '请翻译\n这段话' }],
    ...overrides,
  };
}

describe('role intro snapshots', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('dual-writes content strings and structured items', () => {
    saveRoleIntro('conv-1', makeRole());

    expect(JSON.parse(localStorage.getItem(ROLE_INTRO_KEY('conv-1')) ?? '{}')).toEqual({
      openingMessage: '你好',
      openingQuestions: ['请翻译\n这段话'],
      openingQuestionItems: [{ title: '翻译', content: '请翻译\n这段话' }],
    });
  });

  it('reads titles when the stored content projection matches', () => {
    saveRoleIntro('conv-1', makeRole());
    expect(getRoleIntro('conv-1')).toEqual({
      openingMessage: '你好',
      openingQuestions: [{ title: '翻译', content: '请翻译\n这段话' }],
    });
  });

  it('maps a legacy snapshot to untitled questions', () => {
    localStorage.setItem(ROLE_INTRO_KEY('conv-1'), JSON.stringify({
      openingMessage: '你好',
      openingQuestions: ['旧问题'],
    }));

    expect(getRoleIntro('conv-1')).toEqual({
      openingMessage: '你好',
      openingQuestions: [{ title: null, content: '旧问题' }],
    });
  });

  it('drops stale titles when an older writer changed the content mirror', () => {
    localStorage.setItem(ROLE_INTRO_KEY('conv-1'), JSON.stringify({
      openingMessage: null,
      openingQuestions: ['旧版本改过的正文'],
      openingQuestionItems: [{ title: '过期标题', content: '新版本正文' }],
    }));

    expect(getRoleIntro('conv-1')).toEqual({
      openingMessage: null,
      openingQuestions: [{ title: null, content: '旧版本改过的正文' }],
    });
  });

  it('removes the snapshot when both the message and questions are empty', () => {
    saveRoleIntro('conv-1', makeRole({ opening_message: null, opening_questions: [] }));
    expect(localStorage.getItem(ROLE_INTRO_KEY('conv-1'))).toBeNull();
    expect(getRoleIntro('conv-1')).toBeNull();
  });
});
