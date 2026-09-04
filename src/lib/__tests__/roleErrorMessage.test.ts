import { describe, expect, it } from 'vitest';
import { RoleContextBindingsError } from '../roleContextBindings';
import { getRoleErrorMessage, validateRoleDraft } from '../roleErrorMessage';

const t = ((key: string, opts?: { detail?: string; max?: number; items?: string }) => {
  const map: Record<string, string> = {
    'roles.validation.nameRequired': '请输入角色名称',
    'roles.validation.systemPromptRequired': '请输入系统提示词',
    'roles.validation.openingQuestionContentRequired': '请填写开场问题正文',
    'roles.validation.openingQuestionTitleTooLong': '标题最多 {{max}} 个字'.replace('{{max}}', String(opts?.max ?? '')),
    'roles.validation.openingQuestionTitleHasNewline': '标题不能包含换行',
    'roles.validation.failed': `校验失败：${opts?.detail ?? ''}`,
    'roles.validation.contextBindingsMissing': '角色绑定的知识库或记忆空间已不存在',
    'roles.validation.contextBindingsLoadFailed': '无法加载知识库或记忆空间，请稍后重试',
    'roles.missingBindings': `以下绑定已失效，请移除后再保存：${opts?.items ?? ''}`,
    'roles.saveFailed': '保存角色失败',
    'roles.notFound': '角色不存在',
    'errors.ROLE_CONTEXT_BINDINGS_MISSING': '角色绑定的知识库或记忆空间已不存在',
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

  it('maps missing frontend context bindings to a listed i18n message', () => {
    expect(getRoleErrorMessage(
      new RoleContextBindingsError('missing', ['kb-gone'], ['ns-gone']),
      t,
    )).toBe('以下绑定已失效，请移除后再保存：kb-gone, ns-gone');
  });

  it('maps context binding load failures without claiming ids are deleted', () => {
    expect(getRoleErrorMessage(new RoleContextBindingsError('loadFailed'), t))
      .toBe('无法加载知识库或记忆空间，请稍后重试');
  });

  it('maps ROLE_CONTEXT_BINDINGS_MISSING coded JSON to i18n', () => {
    expect(getRoleErrorMessage(
      '{"code":"ROLE_CONTEXT_BINDINGS_MISSING","args":{"missing_knowledge_base_ids":["kb-1"],"missing_memory_namespace_ids":[]}}',
      t,
    )).toBe('以下绑定已失效，请移除后再保存：kb-1');
    expect(getRoleErrorMessage(
      '{"code":"ROLE_CONTEXT_BINDINGS_MISSING","args":{}}',
      t,
    )).toBe('角色绑定的知识库或记忆空间已不存在');
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
