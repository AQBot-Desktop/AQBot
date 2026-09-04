import { describe, expect, it } from 'vitest';
import {
  agentStatusText,
  countCallableSkills,
  primarySkillReason,
  skillInspectTooltip,
  skillReasonText,
} from '../skillAvailability';
import type { SkillInspectItem, SkillInspectReport } from '@/types';

const t = (key: string, params?: Record<string, unknown>) => {
  if (!params) return key;
  return `${key}:${JSON.stringify(params)}`;
};

function item(partial: Partial<SkillInspectItem>): SkillInspectItem {
  return {
    name: 'demo',
    description: '',
    source: 'aqbot',
    sourcePath: '/tmp/demo/SKILL.md',
    enabled: true,
    disableModelInvocation: false,
    userInvocable: true,
    effective: true,
    effectiveSourcePath: '/tmp/demo/SKILL.md',
    callable: true,
    reasons: [],
    ...partial,
  };
}

describe('skillAvailability', () => {
  it('counts unique callable skill names', () => {
    const report: SkillInspectReport = {
      skillToolAllowed: true,
      scanErrors: [],
      items: [
        item({ name: 'a', callable: true, sourcePath: '/a1' }),
        item({ name: 'a', callable: true, sourcePath: '/a2' }),
        item({ name: 'b', callable: false, sourcePath: '/b' }),
      ],
    };
    expect(countCallableSkills(report)).toBe(1);
  });

  it('maps reason codes through i18n params', () => {
    expect(skillReasonText(t as never, { code: 'disabled', params: {} })).toBe('skills.reason.disabled');
    expect(skillReasonText(t as never, {
      code: 'overridden',
      params: { path: '/win' },
    })).toContain('/win');
    expect(skillReasonText(t as never, {
      code: 'parse_failed',
      params: { message: 'bad', line: '2', column: '1' },
    })).toContain('skills.reason.parseFailedAt');
  });

  it('prefers a blocking reason for picker copy', () => {
    const reason = primarySkillReason(item({
      callable: false,
      reasons: [
        { code: 'callable', params: {} },
        { code: 'disabled', params: {} },
      ],
    }));
    expect(reason?.code).toBe('disabled');
  });

  it('builds hover details only for abnormal inspect tags', () => {
    expect(skillInspectTooltip(t as never, item({ callable: true }))).toBeUndefined();
    expect(skillInspectTooltip(t as never, item({
      callable: false,
      reasons: [
        { code: 'overridden', params: { path: '/win' } },
        { code: 'parse_failed', params: { message: 'bad yaml' } },
      ],
    }))).toContain('/win');
  });

  it('translates wait stages instead of raw codes', () => {
    expect(agentStatusText(t as never, {
      conversationId: 'c',
      stage: 'waiting_model',
    })).toBe('agent.stage.waitingModel');
    expect(agentStatusText(t as never, {
      conversationId: 'c',
      retryAttempt: 2,
      retryWaitMs: 2500,
    })).toContain('agent.stage.retryWait');
  });
});
