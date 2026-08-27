import { describe, expect, it } from 'vitest';
import { getRoleErrorMessage, validateRoleDraft } from '../roleErrorMessage';

const t = ((key: string, opts?: { detail?: string; max?: number }) => {
  const map: Record<string, string> = {
    'roles.validation.nameRequired': '请输入角色名称',
    'roles.validation.systemPromptRequired': '请输入系统提示词',
    'roles.validation.openingQuestionContentRequired': '请填写开场问题正文',
    'roles.validation.openingQuestionTitleTooLong': '标题最多 {{max}} 个字'.replace('{{max}}', String(opts?.max ?? '')),
    'roles.validation.openingQuestionTitleHasNewline': '标题不能包含换行',
    'roles.validation.failed': `校验失败：${opts?.detail ?? ''}`,
    'roles.saveFailed': '保存角色失败',
    'roles.notFound': '角色不存在',
  };
  return map[key] ?? key;
}) as import('i18next').TFunction;

describe('getRoleErrorMessage', () => {
  it('localizes backend name validation errors', () => {
    expect(getRoleErrorMessage('Validation error: name cannot be empty', t)).toBe('请输入角色名称');
  });

  it('localizes backend system_prompt validation errors', () => {
    expect(getRoleErrorMessage('Validation error: system_prompt cannot be empty', t)).toBe(
      '请输入系统提示词',
    );
  });

  it('wraps unknown validation errors', () => {
    expect(getRoleErrorMessage('Validation error: tags invalid', t)).toBe('校验失败：tags invalid');
  });

  it('localizes not-found errors', () => {
    expect(getRoleErrorMessage('Not found: Role abc', t)).toBe('角色不存在');
  });

  it('passes through unknown messages', () => {
    expect(getRoleErrorMessage('network down', t)).toBe('network down');
  });
});

describe('validateRoleDraft', () => {
  it('requires name and system prompt', () => {
    expect(validateRoleDraft({ name: '  ', systemPrompt: '' }, t)).toEqual({
      name: '请输入角色名称',
      systemPrompt: '请输入系统提示词',
    });
    expect(validateRoleDraft({ name: '助手', systemPrompt: '你是助手' }, t)).toEqual({});
  });

  it('rejects an opening question title without content', () => {
    expect(validateRoleDraft({
      name: '助手',
      systemPrompt: '你是助手',
      openingQuestions: [{ title: '翻译', content: '  ' }],
    }, t)).toEqual({
      openingQuestion: '请填写开场问题正文',
      openingQuestionIndex: 0,
    });
  });

  it('drops fully blank opening questions', () => {
    expect(validateRoleDraft({
      name: '助手',
      systemPrompt: '你是助手',
      openingQuestions: [{ title: '', content: '  ' }, { title: '', content: '有效正文' }],
    }, t)).toEqual({});
  });
});
