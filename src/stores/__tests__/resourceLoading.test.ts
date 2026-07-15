import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/invoke', () => ({
  invoke: invokeMock,
}));

describe('light module resource loading', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caches an empty role result and reloads only after invalidation', async () => {
    invokeMock.mockResolvedValue([]);
    const { useRoleStore } = await import('../roleStore');

    await useRoleStore.getState().ensureRolesLoaded();
    await useRoleStore.getState().ensureRolesLoaded();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useRoleStore.getState().rolesMeta.status).toBe('ready');

    useRoleStore.getState().invalidateRoles('restore');
    await useRoleStore.getState().ensureRolesLoaded();

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent skill loads', async () => {
    let resolve!: (value: unknown[]) => void;
    invokeMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { useSkillStore } = await import('../skillStore');

    const first = useSkillStore.getState().ensureSkillsLoaded();
    const second = useSkillStore.getState().ensureSkillsLoaded();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    resolve([]);
    await Promise.all([first, second]);
    expect(useSkillStore.getState().skillsMeta.status).toBe('ready');
  });

  it('coalesces settings loads, treats an empty payload as ready, and reloads after invalidation', async () => {
    let resolveInitial!: (value: Record<string, never>) => void;
    invokeMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ language: 'en-US' });
    const { useSettingsStore } = await import('../settingsStore');

    const first = useSettingsStore.getState().ensureSettingsLoaded();
    const second = useSettingsStore.getState().ensureSettingsLoaded();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    resolveInitial({});
    await Promise.all([first, second]);
    expect(useSettingsStore.getState().settingsMeta.status).toBe('ready');

    useSettingsStore.getState().invalidateSettings('restore');
    await useSettingsStore.getState().ensureSettingsLoaded();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().settings.language).toBe('en-US');
  });

  it('caches knowledge bases independently from the selected document collection', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_knowledge_bases') return Promise.resolve([]);
      if (command === 'list_knowledge_documents') return Promise.resolve([]);
      throw new Error(`Unexpected command: ${command}`);
    });
    const { useKnowledgeStore } = await import('../knowledgeStore');

    await useKnowledgeStore.getState().ensureBasesLoaded();
    await useKnowledgeStore.getState().ensureBasesLoaded();
    await useKnowledgeStore.getState().ensureDocumentsLoaded('base-a');
    await useKnowledgeStore.getState().ensureDocumentsLoaded('base-a');
    await useKnowledgeStore.getState().ensureDocumentsLoaded('base-b');

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'list_knowledge_bases',
      'list_knowledge_documents',
      'list_knowledge_documents',
    ]);
    expect(useKnowledgeStore.getState().documentsMeta.key).toBe('base-b');
  });

  it('reloads knowledge documents after a mutation that overlaps an older request', async () => {
    let resolveOldRequest!: (value: unknown[]) => void;
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_knowledge_documents') {
        listCalls += 1;
        return listCalls === 1
          ? new Promise((done) => { resolveOldRequest = done; })
          : Promise.resolve([]);
      }
      if (command === 'add_knowledge_document') return Promise.resolve(undefined);
      throw new Error(`Unexpected command: ${command}`);
    });
    const { useKnowledgeStore } = await import('../knowledgeStore');

    const oldLoad = useKnowledgeStore.getState().ensureDocumentsLoaded('base-a');
    const mutation = useKnowledgeStore.getState().addDocument('base-a', 'new', '/new.md', 'text/markdown');
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('add_knowledge_document', expect.anything()));
    resolveOldRequest([]);
    await Promise.all([oldLoad, mutation]);

    expect(listCalls).toBe(2);
  });

  it('caches memory namespaces and items even when both results are empty', async () => {
    invokeMock.mockResolvedValue([]);
    const { useMemoryStore } = await import('../memoryStore');

    await useMemoryStore.getState().ensureNamespacesLoaded();
    await useMemoryStore.getState().ensureNamespacesLoaded();
    await useMemoryStore.getState().ensureItemsLoaded('namespace-a');
    await useMemoryStore.getState().ensureItemsLoaded('namespace-a');

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(useMemoryStore.getState().namespacesMeta.status).toBe('ready');
    expect(useMemoryStore.getState().itemsMeta).toMatchObject({
      status: 'ready',
      key: 'namespace-a',
    });
  });

  it('reloads light module lists invalidated while their original requests are in flight', async () => {
    const commands = [
      'list_roles',
      'list_skills',
      'list_knowledge_bases',
      'list_memory_namespaces',
    ] as const;
    const resolveOld = new Map<string, (value: unknown[]) => void>();
    const callCounts = new Map<string, number>();
    invokeMock.mockImplementation((command: string) => {
      if (!commands.includes(command as (typeof commands)[number])) {
        throw new Error(`Unexpected command: ${command}`);
      }
      const count = (callCounts.get(command) ?? 0) + 1;
      callCounts.set(command, count);
      if (count === 1) {
        return new Promise((resolve) => { resolveOld.set(command, resolve); });
      }
      return Promise.resolve([{ id: `fresh-${command}`, name: command }]);
    });
    const [{ useRoleStore }, { useSkillStore }, { useKnowledgeStore }, { useMemoryStore }] =
      await Promise.all([
        import('../roleStore'),
        import('../skillStore'),
        import('../knowledgeStore'),
        import('../memoryStore'),
      ]);

    const oldLoads = [
      useRoleStore.getState().ensureRolesLoaded(),
      useSkillStore.getState().ensureSkillsLoaded(),
      useKnowledgeStore.getState().ensureBasesLoaded(),
      useMemoryStore.getState().ensureNamespacesLoaded(),
    ];
    await vi.waitFor(() => expect(resolveOld.size).toBe(commands.length));
    useRoleStore.getState().invalidateRoles('restore');
    useSkillStore.getState().invalidateSkills('restore');
    useKnowledgeStore.getState().invalidateBases('restore');
    useMemoryStore.getState().invalidateNamespaces('restore');
    const currentLoads = [
      useRoleStore.getState().ensureRolesLoaded(),
      useSkillStore.getState().ensureSkillsLoaded(),
      useKnowledgeStore.getState().ensureBasesLoaded(),
      useMemoryStore.getState().ensureNamespacesLoaded(),
    ];
    for (const command of commands) resolveOld.get(command)?.([]);
    await Promise.all([...oldLoads, ...currentLoads]);

    expect(Object.fromEntries(callCounts)).toEqual(Object.fromEntries(
      commands.map((command) => [command, 2]),
    ));
    expect(useRoleStore.getState().roles[0]?.id).toBe('fresh-list_roles');
    expect(useSkillStore.getState().skills[0]?.name).toBe('list_skills');
    expect(useKnowledgeStore.getState().bases[0]?.id).toBe('fresh-list_knowledge_bases');
    expect(useMemoryStore.getState().namespaces[0]?.id).toBe('fresh-list_memory_namespaces');
  });

  it('reloads knowledge documents and memory items after in-flight invalidation', async () => {
    const commands = ['list_knowledge_documents', 'list_memory_items'] as const;
    const resolveOld = new Map<string, (value: unknown[]) => void>();
    const callCounts = new Map<string, number>();
    invokeMock.mockImplementation((command: string) => {
      if (!commands.includes(command as (typeof commands)[number])) {
        throw new Error(`Unexpected command: ${command}`);
      }
      const count = (callCounts.get(command) ?? 0) + 1;
      callCounts.set(command, count);
      if (count === 1) {
        return new Promise((resolve) => { resolveOld.set(command, resolve); });
      }
      return Promise.resolve([{ id: `fresh-${command}` }]);
    });
    const [{ useKnowledgeStore }, { useMemoryStore }] = await Promise.all([
      import('../knowledgeStore'),
      import('../memoryStore'),
    ]);

    const oldLoads = [
      useKnowledgeStore.getState().ensureDocumentsLoaded('base-a'),
      useMemoryStore.getState().ensureItemsLoaded('namespace-a'),
    ];
    await vi.waitFor(() => expect(resolveOld.size).toBe(commands.length));
    useKnowledgeStore.getState().invalidateDocuments('restore');
    useMemoryStore.getState().invalidateItems('restore');
    const currentLoads = [
      useKnowledgeStore.getState().ensureDocumentsLoaded('base-a'),
      useMemoryStore.getState().ensureItemsLoaded('namespace-a'),
    ];
    for (const command of commands) resolveOld.get(command)?.([]);
    await Promise.all([...oldLoads, ...currentLoads]);

    expect(Object.fromEntries(callCounts)).toEqual({
      list_knowledge_documents: 2,
      list_memory_items: 2,
    });
    expect(useKnowledgeStore.getState().documents[0]?.id).toBe('fresh-list_knowledge_documents');
    expect(useMemoryStore.getState().items[0]?.id).toBe('fresh-list_memory_items');
  });

  it('reapplies a successful optimistic skill mutation after an overlapping reload', async () => {
    const disabledSkill = {
      name: 'demo',
      description: 'Demo skill',
      source: 'aqbot' as const,
      sourcePath: '/skills/demo',
      enabled: false,
      hasUpdate: false,
      userInvocable: true,
    };
    let resolveOldList!: (value: unknown[]) => void;
    let resolveToggle!: () => void;
    let listCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_skills') {
        listCalls += 1;
        return listCalls === 1
          ? new Promise((resolve) => { resolveOldList = resolve; })
          : Promise.resolve([disabledSkill]);
      }
      if (command === 'toggle_skill') {
        return new Promise<void>((resolve) => { resolveToggle = resolve; });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const { useSkillStore } = await import('../skillStore');
    useSkillStore.setState({ skills: [disabledSkill] });

    const load = useSkillStore.getState().ensureSkillsLoaded();
    const mutation = useSkillStore.getState().toggleSkill('demo', true);
    resolveOldList([disabledSkill]);
    await load;
    expect(useSkillStore.getState().skills[0]?.enabled).toBe(false);

    resolveToggle();
    await mutation;
    expect(useSkillStore.getState().skills[0]?.enabled).toBe(true);
  });

  it('caches empty search provider and MCP server resources across Activity resumes', async () => {
    invokeMock.mockResolvedValue([]);
    const [{ useSearchStore }, { useMcpStore }] = await Promise.all([
      import('../searchStore'),
      import('../mcpStore'),
    ]);

    await useSearchStore.getState().ensureProvidersLoaded();
    await useSearchStore.getState().ensureProvidersLoaded();
    await useMcpStore.getState().ensureServersLoaded();
    await useMcpStore.getState().ensureServersLoaded();

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'list_search_providers',
      'list_mcp_servers',
    ]);
    expect(useSearchStore.getState().providersMeta.status).toBe('ready');
    expect(useMcpStore.getState().serversMeta.status).toBe('ready');
  });

  it('serves stale file rows while revalidating a query older than five seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
    const oldRow = { id: 'old', name: 'old.png', path: '/old.png', missing: false };
    const newRow = { id: 'new', name: 'new.png', path: '/new.png', missing: false };
    let resolveRefresh!: (value: unknown[]) => void;
    invokeMock
      .mockResolvedValueOnce([oldRow])
      .mockReturnValueOnce(new Promise((done) => { resolveRefresh = done; }));
    const { useFileStore } = await import('../fileStore');

    await useFileStore.getState().ensureCategoryLoaded('images');
    vi.advanceTimersByTime(5_001);
    const refresh = useFileStore.getState().ensureCategoryLoaded('images');

    expect(useFileStore.getState().rows).toEqual([expect.objectContaining(oldRow)]);
    expect(useFileStore.getState().loading).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    resolveRefresh([newRow]);
    await refresh;
    expect(useFileStore.getState().rows).toEqual([expect.objectContaining(newRow)]);
  });

  it('does not restore a file query invalidated during background revalidation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
    let resolveStaleRequest!: (value: unknown[]) => void;
    invokeMock
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(new Promise((done) => { resolveStaleRequest = done; }))
      .mockResolvedValueOnce([]);
    const { useFileStore } = await import('../fileStore');

    await useFileStore.getState().ensureCategoryLoaded('images');
    vi.advanceTimersByTime(5_001);
    const staleRefresh = useFileStore.getState().ensureCategoryLoaded('images');
    useFileStore.getState().invalidateFiles('path-change');
    resolveStaleRequest([]);
    await staleRefresh;
    await useFileStore.getState().ensureCategoryLoaded('images');

    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it('reuses the gateway status and empty key list until a forced poll', async () => {
    const status = {
      is_running: false,
      listen_address: '127.0.0.1',
      port: 8080,
      ssl_enabled: false,
      started_at: null,
      https_port: null,
      force_ssl: false,
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_gateway_status') return Promise.resolve(status);
      if (command === 'list_gateway_keys') return Promise.resolve([]);
      throw new Error(`Unexpected command: ${command}`);
    });
    const { useGatewayStore } = await import('../gatewayStore');

    await useGatewayStore.getState().ensureStatusLoaded();
    await useGatewayStore.getState().ensureStatusLoaded();
    await useGatewayStore.getState().ensureKeysLoaded();
    await useGatewayStore.getState().ensureKeysLoaded();
    await useGatewayStore.getState().fetchStatus();

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'get_gateway_status',
      'list_gateway_keys',
      'get_gateway_status',
    ]);
  });

  it('reloads every gateway resource invalidated while an older request is in flight', async () => {
    const commands = ['get_gateway_status', 'get_gateway_metrics', 'list_gateway_keys'] as const;
    const callCounts = new Map<string, number>();
    const resolveOld = new Map<string, (value: unknown) => void>();
    const freshValues: Record<(typeof commands)[number], unknown> = {
      get_gateway_status: { is_running: true },
      get_gateway_metrics: { total_requests: 2 },
      list_gateway_keys: [{ id: 'fresh-key' }],
    };
    invokeMock.mockImplementation((command: string) => {
      const callCount = (callCounts.get(command) ?? 0) + 1;
      callCounts.set(command, callCount);
      if (callCount === 1) {
        return new Promise((resolve) => { resolveOld.set(command, resolve); });
      }
      return Promise.resolve(freshValues[command as (typeof commands)[number]]);
    });
    const { useGatewayStore } = await import('../gatewayStore');

    const loads = [
      useGatewayStore.getState().ensureStatusLoaded(),
      useGatewayStore.getState().ensureMetricsLoaded(),
      useGatewayStore.getState().ensureKeysLoaded(),
    ];
    await vi.waitFor(() => expect(resolveOld.size).toBe(3));
    useGatewayStore.getState().invalidateGatewayResources('restore');
    for (const command of commands) resolveOld.get(command)?.({ stale: command });
    await Promise.all(loads);

    expect(Object.fromEntries(callCounts)).toEqual({
      get_gateway_status: 2,
      get_gateway_metrics: 2,
      list_gateway_keys: 2,
    });
    expect(useGatewayStore.getState()).toMatchObject({
      status: freshValues.get_gateway_status,
      metrics: freshValues.get_gateway_metrics,
      keys: freshValues.list_gateway_keys,
      statusMeta: { status: 'ready', revision: 1 },
      metricsMeta: { status: 'ready', revision: 1 },
      keysMeta: { status: 'ready', revision: 1 },
    });
  });

  it('coalesces and caches gateway logs, usage, diagnostics, and CLI status with TTLs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_gateway_request_logs') return Promise.resolve([]);
      if (command === 'get_gateway_usage_by_key') return Promise.resolve([]);
      if (command === 'get_gateway_usage_by_provider') return Promise.resolve([]);
      if (command === 'get_gateway_usage_by_day') return Promise.resolve([]);
      if (command === 'get_gateway_diagnostics') return Promise.resolve([]);
      if (command === 'get_all_cli_tool_statuses') return Promise.resolve([]);
      throw new Error(`Unexpected command: ${command}`);
    });
    const { useGatewayStore } = await import('../gatewayStore');

    await Promise.all([
      useGatewayStore.getState().ensureRequestLogsLoaded(100, 0, { maxAgeMs: 5_000 }),
      useGatewayStore.getState().ensureRequestLogsLoaded(100, 0, { maxAgeMs: 5_000 }),
      useGatewayStore.getState().ensureUsageLoaded(30, { maxAgeMs: 30_000 }),
      useGatewayStore.getState().ensureUsageLoaded(30, { maxAgeMs: 30_000 }),
      useGatewayStore.getState().ensureDiagnosticsLoaded({ maxAgeMs: 30_000 }),
      useGatewayStore.getState().ensureDiagnosticsLoaded({ maxAgeMs: 30_000 }),
      useGatewayStore.getState().ensureCliToolStatusesLoaded({ maxAgeMs: 30_000 }),
      useGatewayStore.getState().ensureCliToolStatusesLoaded({ maxAgeMs: 30_000 }),
    ]);

    expect(invokeMock.mock.calls.map(([command]) => command).sort()).toEqual([
      'get_all_cli_tool_statuses',
      'get_gateway_diagnostics',
      'get_gateway_usage_by_day',
      'get_gateway_usage_by_key',
      'get_gateway_usage_by_provider',
      'list_gateway_request_logs',
    ]);
    expect(useGatewayStore.getState()).toMatchObject({
      requestLogsMeta: { status: 'ready', key: 'gateway-request-logs:100:0' },
      usageMeta: { status: 'ready', key: 'gateway-usage:30' },
      diagnosticsMeta: { status: 'ready', key: 'gateway-diagnostics' },
      cliToolsMeta: { status: 'ready', key: 'gateway-cli-tools' },
    });

    vi.advanceTimersByTime(5_001);
    await useGatewayStore.getState().ensureRequestLogsLoaded(100, 0, { maxAgeMs: 5_000 });
    await useGatewayStore.getState().ensureUsageLoaded(30, { maxAgeMs: 30_000 });

    expect(invokeMock.mock.calls.filter(([command]) => command === 'list_gateway_request_logs')).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([command]) => command.startsWith('get_gateway_usage_'))).toHaveLength(3);
  });

  it('reloads extended gateway resources invalidated while requests are in flight', async () => {
    const commands = [
      'list_gateway_request_logs',
      'get_gateway_usage_by_key',
      'get_gateway_usage_by_provider',
      'get_gateway_usage_by_day',
      'get_gateway_diagnostics',
      'get_all_cli_tool_statuses',
    ] as const;
    const resolveOld = new Map<string, (value: unknown[]) => void>();
    const callCounts = new Map<string, number>();
    invokeMock.mockImplementation((command: string) => {
      if (!commands.includes(command as (typeof commands)[number])) {
        throw new Error(`Unexpected command: ${command}`);
      }
      const count = (callCounts.get(command) ?? 0) + 1;
      callCounts.set(command, count);
      if (count === 1) {
        return new Promise((resolve) => { resolveOld.set(command, resolve); });
      }
      return Promise.resolve([]);
    });
    const { useGatewayStore } = await import('../gatewayStore');

    const oldLoads = [
      useGatewayStore.getState().ensureRequestLogsLoaded(),
      useGatewayStore.getState().ensureUsageLoaded(),
      useGatewayStore.getState().ensureDiagnosticsLoaded(),
      useGatewayStore.getState().ensureCliToolStatusesLoaded(),
    ];
    await vi.waitFor(() => expect(resolveOld.size).toBe(commands.length));
    useGatewayStore.getState().invalidateGatewayResources('restore');
    for (const command of commands) resolveOld.get(command)?.([]);
    await Promise.all(oldLoads);

    expect(Object.fromEntries(callCounts)).toEqual(Object.fromEntries(
      commands.map((command) => [command, 2]),
    ));
    expect(useGatewayStore.getState()).toMatchObject({
      requestLogsMeta: { status: 'ready', revision: 1 },
      usageMeta: { status: 'ready', revision: 1 },
      diagnosticsMeta: { status: 'ready', revision: 1 },
      cliToolsMeta: { status: 'ready', revision: 1 },
    });
  });
});
