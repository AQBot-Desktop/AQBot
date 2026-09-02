import { describe, expect, it } from 'vitest';
import {
  AGENT_CONFIGURABLE_TOOLS,
  defaultAgentAllowedTools,
} from '../agentAllowedTools';

describe('agentAllowedTools catalog', () => {
  it('keeps the 31 configurable tools in the shared display order', () => {
    expect([...AGENT_CONFIGURABLE_TOOLS]).toEqual([
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'NotebookEdit',
      'Bash',
      'LSP',
      'WebFetch',
      'WebSearch',
      'AskUserQuestion',
      'Skill',
      'ToolSearch',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'TaskStop',
      'TaskOutput',
      'TodoWrite',
      'SendMessage',
      'TeamCreate',
      'TeamDelete',
      'EnterPlanMode',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
      'CronCreate',
      'CronDelete',
      'CronList',
      'Config',
    ]);
    expect(new Set(AGENT_CONFIGURABLE_TOOLS).size).toBe(31);
    expect(defaultAgentAllowedTools()).toEqual([...AGENT_CONFIGURABLE_TOOLS]);
    expect(AGENT_CONFIGURABLE_TOOLS).not.toContain('ListMcpResources');
    expect(AGENT_CONFIGURABLE_TOOLS).not.toContain('ReadMcpResource');
  });
});
