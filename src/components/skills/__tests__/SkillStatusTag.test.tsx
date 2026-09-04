import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { SkillInspectItem } from '@/types';
import { skillStatusTag } from '../SkillStatusTag';

const t = ((key: string, opts?: Record<string, string>) => {
  if (key === 'skills.reason.overridden') return `Covered by ${opts?.path}`;
  return key;
}) as TFunction;

function item(partial: Partial<SkillInspectItem>): SkillInspectItem {
  return {
    name: 'demo',
    description: '',
    source: 'agents',
    sourcePath: '/tmp/demo/SKILL.md',
    enabled: true,
    disableModelInvocation: false,
    userInvocable: true,
    effective: false,
    effectiveSourcePath: '/win/SKILL.md',
    callable: false,
    reasons: [],
    ...partial,
  };
}

describe('skillStatusTag', () => {
  it('does not attach a tooltip to callable skills', () => {
    render(<>{skillStatusTag(item({ callable: true, reasons: [{ code: 'callable', params: {} }] }), t)}</>);
    expect(screen.getByText('skills.availabilityCallable')).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows exception details on hover for overridden skills', async () => {
    const user = userEvent.setup();
    render(<>{skillStatusTag(item({
      reasons: [{ code: 'overridden', params: { path: '/win/SKILL.md' } }],
    }), t)}</>);
    await user.hover(screen.getByText('skills.availabilityOverridden'));
    expect(await screen.findByText('Covered by /win/SKILL.md')).toBeInTheDocument();
  });
});
