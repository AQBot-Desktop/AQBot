export const AGENT_ALLOWED_TOOL_GROUPS = [
  {
    id: 'file',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'],
  },
  {
    id: 'exec',
    tools: ['Bash', 'LSP'],
  },
  {
    id: 'web',
    tools: ['WebFetch', 'WebSearch'],
  },
  {
    id: 'interactive',
    tools: ['AskUserQuestion', 'Skill', 'ToolSearch'],
  },
  {
    id: 'task',
    tools: [
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'TaskStop',
      'TaskOutput',
      'TodoWrite',
    ],
  },
  {
    id: 'collab',
    tools: [
      'SendMessage',
      'TeamCreate',
      'TeamDelete',
      'EnterPlanMode',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
    ],
  },
  {
    id: 'automation',
    tools: ['CronCreate', 'CronDelete', 'CronList', 'Config'],
  },
] as const;

export const AGENT_CONFIGURABLE_TOOLS: readonly string[] =
  AGENT_ALLOWED_TOOL_GROUPS.flatMap((group) => [...group.tools]);

export const AGENT_ALLOWED_TOOL_GROUP_I18N_KEYS: Record<
  (typeof AGENT_ALLOWED_TOOL_GROUPS)[number]['id'],
  string
> = {
  file: 'settings.agentAllowedToolsGroupFile',
  exec: 'settings.agentAllowedToolsGroupExec',
  web: 'settings.agentAllowedToolsGroupWeb',
  interactive: 'settings.agentAllowedToolsGroupInteractive',
  task: 'settings.agentAllowedToolsGroupTask',
  collab: 'settings.agentAllowedToolsGroupCollab',
  automation: 'settings.agentAllowedToolsGroupAutomation',
};

export function defaultAgentAllowedTools(): string[] {
  return [...AGENT_CONFIGURABLE_TOOLS];
}

export function isConfigurableAgentTool(name: string): boolean {
  return AGENT_CONFIGURABLE_TOOLS.includes(name);
}
