import { Tag, Tooltip } from 'antd';
import type { TFunction } from 'i18next';
import { inspectItemForSkill, primarySkillReason, skillInspectTooltip } from '@/lib/skillAvailability';
import type { Skill, SkillInspectItem, SkillInspectReport } from '@/types';

function statusTagVisual(item: SkillInspectItem, t: TFunction): { color?: string; label: string } {
  if (item.callable) {
    return { color: 'success', label: t('skills.availabilityCallable') };
  }
  const reason = primarySkillReason(item);
  switch (reason?.code) {
    case 'disabled':
      return { label: t('skills.disabled') };
    case 'skill_tool_disabled':
      return { color: 'warning', label: t('skills.availabilitySkillToolOff') };
    case 'overridden':
      return { color: 'warning', label: t('skills.availabilityOverridden') };
    case 'parse_failed':
      return { color: 'error', label: t('skills.availabilityParseFailed') };
    case 'unreadable':
      return { color: 'error', label: t('skills.availabilityUnreadable') };
    case 'disable_model_invocation':
      return { color: 'processing', label: t('skills.availabilityManualOnly') };
    default:
      return { label: t('skills.availabilityNotCallable') };
  }
}

export function skillStatusTag(item: SkillInspectItem | undefined, t: TFunction) {
  if (!item) return null;
  const { color, label } = statusTagVisual(item, t);
  const tooltip = skillInspectTooltip(t, item);
  const tag = (
    <Tag color={color} style={tooltip ? { cursor: 'help' } : undefined}>
      {label}
    </Tag>
  );
  if (!tooltip) return tag;
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}>
      {tag}
    </Tooltip>
  );
}

export function skillInspectTagFor(
  report: SkillInspectReport | null,
  skill: Skill,
  t: TFunction,
) {
  return skillStatusTag(inspectItemForSkill(report, skill.sourcePath, skill.name), t);
}
