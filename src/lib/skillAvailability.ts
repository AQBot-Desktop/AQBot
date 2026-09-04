import type { TFunction } from 'i18next';
import type { AgentStatusEvent } from '@/types/agent';
import type { SkillAvailabilityReason, SkillInspectItem, SkillInspectReport } from '@/types';

export function skillReasonText(
  t: TFunction,
  reason: SkillAvailabilityReason,
  short = false,
): string {
  const params = { code: reason.code, ...reason.params };
  if (short) {
    switch (reason.code) {
      case 'disabled':
        return t('chat.skill.reason.disabled');
      case 'skill_tool_disabled':
        return t('chat.skill.reason.skillToolDisabled');
      case 'overridden':
        return t('chat.skill.reason.overridden', params);
      case 'parse_failed':
        return reason.params.line && reason.params.column
          ? t('chat.skill.reason.parseFailedAt', params)
          : t('chat.skill.reason.parseFailed', params);
      case 'unreadable':
        return t('chat.skill.reason.unreadable', params);
      case 'disable_model_invocation':
        return t('chat.skill.reason.disableModelInvocation');
      default:
        return t('chat.skill.reason.unknown', params);
    }
  }
  switch (reason.code) {
    case 'disabled':
      return t('skills.reason.disabled');
    case 'skill_tool_disabled':
      return t('skills.reason.skillToolDisabled');
    case 'overridden':
      return t('skills.reason.overridden', params);
    case 'parse_failed':
      return reason.params.line && reason.params.column
        ? t('skills.reason.parseFailedAt', params)
        : t('skills.reason.parseFailed', params);
    case 'unreadable':
      return t('skills.reason.unreadable', params);
    case 'disable_model_invocation':
      return t('skills.reason.disableModelInvocation');
    case 'callable':
      return t('skills.reason.callable');
    default:
      return t('skills.reason.unknown', params);
  }
}

export function primarySkillReason(
  item: SkillInspectItem,
): SkillAvailabilityReason | null {
  return item.reasons.find((reason) => reason.code !== 'callable') ?? item.reasons[0] ?? null;
}

export function countCallableSkills(report: SkillInspectReport | null | undefined): number {
  if (!report) return 0;
  const seen = new Set<string>();
  let count = 0;
  for (const item of report.items) {
    if (!item.callable) continue;
    const key = item.name;
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

export function inspectItemForSkill(
  report: SkillInspectReport | null | undefined,
  sourcePath: string,
  name: string,
): SkillInspectItem | undefined {
  if (!report) return undefined;
  return report.items.find((item) => item.sourcePath === sourcePath)
    ?? report.items.find((item) => item.name === name);
}

export function skillInspectTooltip(
  t: TFunction,
  item: SkillInspectItem | undefined,
): string | undefined {
  if (!item || item.callable) return undefined;
  const texts = item.reasons
    .filter((reason) => reason.code !== 'callable')
    .map((reason) => skillReasonText(t, reason));
  if (texts.length === 0) return undefined;
  return texts.join('\n');
}

export function agentStatusText(t: TFunction, event: AgentStatusEvent | string | undefined): string {
  if (!event) return '';
  if (typeof event === 'string') return event;
  if (event.retryAttempt != null && event.retryWaitMs != null) {
    return t('agent.stage.retryWait', {
      attempt: event.retryAttempt,
      waitSeconds: Math.max(1, Math.round(event.retryWaitMs / 1000)),
    });
  }
  if (event.stage) {
    switch (event.stage) {
      case 'preparing_resources':
        return t('agent.stage.preparingResources');
      case 'preparing_skills':
        return t('agent.stage.preparingSkills');
      case 'preparing_context':
        return t('agent.stage.preparingContext');
      case 'waiting_model':
        return t('agent.stage.waitingModel');
      case 'streaming':
        return t('agent.stage.streaming');
      default:
        break;
    }
  }
  return event.message ?? '';
}
