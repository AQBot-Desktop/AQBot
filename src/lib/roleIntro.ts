import {
  decodeStoredOpeningQuestions,
  encodeStoredOpeningQuestions,
  parseOpeningQuestionList,
} from '@/lib/openingQuestions';
import type { Role, RoleOpeningQuestion } from '@/types';

export interface RoleIntro {
  openingMessage: string | null;
  openingQuestions: RoleOpeningQuestion[];
}

export const ROLE_INTRO_KEY = (conversationId: string) => `aqbot_role_intro_${conversationId}`;

function normalizeIncomingQuestions(
  value: Role['opening_questions'] | unknown,
): RoleOpeningQuestion[] {
  const parsed = parseOpeningQuestionList(value);
  return parsed ?? [];
}

export function saveRoleIntro(
  conversationId: string,
  role: Pick<Role, 'opening_message' | 'opening_questions'>,
) {
  const openingQuestions = normalizeIncomingQuestions(role.opening_questions);
  const intro = {
    openingMessage: role.opening_message ?? null,
    ...encodeStoredOpeningQuestions(openingQuestions),
  };
  if (!intro.openingMessage && intro.openingQuestionItems.length === 0) {
    localStorage.removeItem(ROLE_INTRO_KEY(conversationId));
    return;
  }
  localStorage.setItem(ROLE_INTRO_KEY(conversationId), JSON.stringify(intro));
}

export function getRoleIntro(conversationId: string): RoleIntro | null {
  try {
    const raw = localStorage.getItem(ROLE_INTRO_KEY(conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      openingMessage?: unknown;
      openingQuestions?: unknown;
      openingQuestionItems?: unknown;
    };
    const decoded = decodeStoredOpeningQuestions({
      openingQuestions: parsed.openingQuestions,
      openingQuestionItems: parsed.openingQuestionItems,
    });
    if (!decoded.ok) return null;
    if (decoded.usedLegacyFallback || decoded.recoveredFromV2) {
      console.warn('[roleIntro] opening question snapshot used compatibility fallback', {
        conversationId,
        usedLegacyFallback: decoded.usedLegacyFallback === true,
        recoveredFromV2: decoded.recoveredFromV2 === true,
      });
    }
    const openingMessage = typeof parsed.openingMessage === 'string' && parsed.openingMessage.trim()
      ? parsed.openingMessage
      : null;
    return openingMessage || decoded.items.length > 0
      ? { openingMessage, openingQuestions: decoded.items }
      : null;
  } catch {
    return null;
  }
}
