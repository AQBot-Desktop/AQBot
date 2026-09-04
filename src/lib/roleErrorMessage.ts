import type { TFunction } from 'i18next';
import { parseCodedError } from '@/lib/contextErrorMessage';
import { getErrorMessage } from '@/lib/errorMessage';
import {
  OPENING_QUESTION_TITLE_MAX_CHARS,
  normalizeOpeningQuestions,
  type OpeningQuestionDraft,
} from '@/lib/openingQuestions';
import {
  formatRoleContextBindingItems,
  isRoleContextBindingsError,
} from '@/lib/roleContextBindings';

/** Known backend role validation payloads (after "Validation error: " prefix). */
const ROLE_VALIDATION_KEYS: Record<string, string> = {
  'name cannot be empty': 'roles.validation.nameRequired',
  'system_prompt cannot be empty': 'roles.validation.systemPromptRequired',
  'opening question content cannot be empty': 'roles.validation.openingQuestionContentRequired',
  'opening question title cannot contain newlines': 'roles.validation.openingQuestionTitleHasNewline',
  'opening question title is too long': 'roles.validation.openingQuestionTitleTooLong',
};

/**
 * Turn backend / transport errors into user-facing role messages.
 * Maps English validation strings from the Rust layer to i18n keys.
 */
function stringIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function missingBindingsMessage(
  t: TFunction,
  knowledgeBaseIds: string[],
  memoryNamespaceIds: string[],
  fallbackKey: string,
): string {
  const items = formatRoleContextBindingItems(knowledgeBaseIds, memoryNamespaceIds);
  return items ? t('roles.missingBindings', { items }) : t(fallbackKey);
}

export function getRoleErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof Error && error.name === 'ConversationRoleStorageError') {
    return t('roles.applyFailed');
  }
  if (isRoleContextBindingsError(error)) {
    if (error.kind === 'loadFailed') {
      return t('roles.validation.contextBindingsLoadFailed');
    }
    return missingBindingsMessage(
      t,
      error.missingKnowledgeBaseIds,
      error.missingMemoryNamespaceIds,
      'roles.validation.contextBindingsMissing',
    );
  }
  const coded = parseCodedError(error);
  if (coded?.code === 'ROLE_CONTEXT_BINDINGS_MISSING') {
    return missingBindingsMessage(
      t,
      stringIdList(coded.args?.missing_knowledge_base_ids),
      stringIdList(coded.args?.missing_memory_namespace_ids),
      'errors.ROLE_CONTEXT_BINDINGS_MISSING',
    );
  }
  const raw = getErrorMessage(error).trim();
  if (!raw) return t('roles.saveFailed');

  const withoutPrefix = raw.replace(/^Validation error:\s*/i, '').trim();
  const key = ROLE_VALIDATION_KEYS[withoutPrefix.toLowerCase()];
  if (key) {
    if (key === 'roles.validation.openingQuestionTitleTooLong') {
      return t(key, { max: OPENING_QUESTION_TITLE_MAX_CHARS });
    }
    return t(key);
  }

  if (/^Validation error:/i.test(raw)) {
    return t('roles.validation.failed', { detail: withoutPrefix || raw });
  }

  if (/^Not found:/i.test(raw)) {
    return t('roles.notFound');
  }

  return raw;
}

export interface RoleDraftValidation {
  name?: string;
  systemPrompt?: string;
  openingQuestion?: string;
  openingQuestionIndex?: number;
}

function openingQuestionErrorMessage(
  code: 'contentRequired' | 'titleTooLong' | 'titleHasNewline',
  t: TFunction,
): string {
  if (code === 'contentRequired') {
    return t('roles.validation.openingQuestionContentRequired');
  }
  if (code === 'titleHasNewline') {
    return t('roles.validation.openingQuestionTitleHasNewline');
  }
  return t('roles.validation.openingQuestionTitleTooLong', {
    max: OPENING_QUESTION_TITLE_MAX_CHARS,
  });
}

/** Client-side draft validation (mirrors backend required_text for name / system_prompt). */
export function validateRoleDraft(
  draft: { name: string; systemPrompt: string; openingQuestions?: OpeningQuestionDraft[] },
  t: TFunction,
): RoleDraftValidation {
  const errors: RoleDraftValidation = {};
  if (!draft.name.trim()) {
    errors.name = t('roles.validation.nameRequired');
  }
  if (!draft.systemPrompt.trim()) {
    errors.systemPrompt = t('roles.validation.systemPromptRequired');
  }
  if (draft.openingQuestions) {
    const normalized = normalizeOpeningQuestions(draft.openingQuestions);
    if (!normalized.ok) {
      errors.openingQuestion = openingQuestionErrorMessage(normalized.code, t);
      errors.openingQuestionIndex = normalized.index;
    }
  }
  return errors;
}
