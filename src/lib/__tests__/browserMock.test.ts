import { beforeEach, describe, expect, it } from 'vitest';

import { handleCommand } from '../browserMock';

type GatewayTemplate = {
  id: string;
  target: string;
  content: string;
};

function mockConversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    category_id: null,
    parent_conversation_id: null,
    is_archived: false,
    sort_order: 0,
    updated_at: 100,
    multi_model_display_mode_override: null,
    ...overrides,
  };
}

const EXPECTED_SHUAI_API_PROVIDER = {
  id: 'builtin-shuaiapi',
  builtin_id: 'shuaiapi',
  name: 'SHUAI API',
  provider_type: 'openai',
  api_host: 'https://api.shuaiapi.com',
  api_path: null,
  enabled: false,
  models: [],
  keys: [],
  proxy_config: null,
  sort_order: 9,
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

const EXPECTED_GPTNB_PROVIDER = {
  id: 'builtin-gptnb',
  builtin_id: 'gptnb',
  name: 'GPTNB',
  provider_type: 'openai',
  api_host: 'https://goapi.gptnb.ai',
  api_path: null,
  enabled: false,
  models: [],
  keys: [],
  proxy_config: null,
  sort_order: 10,
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

describe('browserMock built-in providers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('initializes SHUAI API and GPTNB with the expected fields and ordering', async () => {
    const providers = await handleCommand<any[]>('list_providers');
    const shuaiApi = providers.find((provider) => provider.id === 'builtin-shuaiapi');
    const gptnb = providers.find((provider) => provider.id === 'builtin-gptnb');

    expect(shuaiApi).toEqual(EXPECTED_SHUAI_API_PROVIDER);
    expect(gptnb).toEqual(EXPECTED_GPTNB_PROVIDER);
    expect(providers.map((provider) => provider.id)).toEqual(expect.arrayContaining([
      'builtin-minimax',
      'builtin-shuaiapi',
      'builtin-gptnb',
      'builtin-jina',
    ]));
    expect(providers.findIndex((provider) => provider.id === 'builtin-shuaiapi')).toBe(
      providers.findIndex((provider) => provider.id === 'builtin-minimax') + 1,
    );
    expect(providers.findIndex((provider) => provider.id === 'builtin-gptnb')).toBe(
      providers.findIndex((provider) => provider.id === 'builtin-shuaiapi') + 1,
    );
    expect(providers.findIndex((provider) => provider.id === 'builtin-jina')).toBe(
      providers.findIndex((provider) => provider.id === 'builtin-gptnb') + 1,
    );
    expect(providers.find((provider) => provider.id === 'builtin-jina')?.sort_order).toBe(11);
    expect(providers.find((provider) => provider.id === 'builtin-cohere')?.sort_order).toBe(12);
    expect(providers.find((provider) => provider.id === 'builtin-voyage')?.sort_order).toBe(13);
  });

  it('adds the complete SHUAI API provider to existing localStorage', async () => {
    const providers = await handleCommand<any[]>('list_providers');
    const legacySortOrders: Record<string, number> = {
      'builtin-jina': 9,
      'builtin-cohere': 10,
      'builtin-voyage': 11,
    };
    const legacyProviders = providers
      .filter((provider) => provider.id !== 'builtin-shuaiapi' && provider.id !== 'builtin-gptnb')
      .map((provider) => ({
        ...provider,
        sort_order: legacySortOrders[provider.id] ?? provider.sort_order,
      }));
    localStorage.setItem(
      'aqbot_providers',
      JSON.stringify(legacyProviders),
    );

    const upgradedProviders = await handleCommand<any[]>('list_providers');
    const shuaiApi = upgradedProviders.find((provider) => provider.id === 'builtin-shuaiapi');
    const gptnb = upgradedProviders.find((provider) => provider.id === 'builtin-gptnb');
    const persistedProviders = JSON.parse(localStorage.getItem('aqbot_providers') ?? '[]');

    expect(shuaiApi).toEqual(EXPECTED_SHUAI_API_PROVIDER);
    expect(gptnb).toEqual(EXPECTED_GPTNB_PROVIDER);
    expect(persistedProviders.find((provider: any) => provider.id === 'builtin-shuaiapi'))
      .toEqual(EXPECTED_SHUAI_API_PROVIDER);
    expect(persistedProviders.find((provider: any) => provider.id === 'builtin-gptnb'))
      .toEqual(EXPECTED_GPTNB_PROVIDER);
    expect(upgradedProviders.findIndex((provider) => provider.id === 'builtin-shuaiapi')).toBe(
      upgradedProviders.findIndex((provider) => provider.id === 'builtin-minimax') + 1,
    );
    expect(upgradedProviders.findIndex((provider) => provider.id === 'builtin-gptnb')).toBe(
      upgradedProviders.findIndex((provider) => provider.id === 'builtin-shuaiapi') + 1,
    );
    expect(upgradedProviders.find((provider) => provider.id === 'builtin-jina')?.sort_order).toBe(11);
    expect(upgradedProviders.find((provider) => provider.id === 'builtin-cohere')?.sort_order).toBe(12);
    expect(upgradedProviders.find((provider) => provider.id === 'builtin-voyage')?.sort_order).toBe(13);
  });

  it('adds GPTNB to existing localStorage that already has SHUAI API', async () => {
    const providers = await handleCommand<any[]>('list_providers');
    const legacySortOrders: Record<string, number> = {
      'builtin-jina': 10,
      'builtin-cohere': 11,
      'builtin-voyage': 12,
    };
    const legacyProviders = providers
      .filter((provider) => provider.id !== 'builtin-gptnb')
      .map((provider) => ({
        ...provider,
        sort_order: legacySortOrders[provider.id] ?? provider.sort_order,
      }));
    localStorage.setItem('aqbot_providers', JSON.stringify(legacyProviders));

    const upgradedProviders = await handleCommand<any[]>('list_providers');
    const gptnb = upgradedProviders.find((provider) => provider.id === 'builtin-gptnb');

    expect(gptnb).toEqual(EXPECTED_GPTNB_PROVIDER);
    expect(upgradedProviders.findIndex((provider) => provider.id === 'builtin-gptnb')).toBe(
      upgradedProviders.findIndex((provider) => provider.id === 'builtin-shuaiapi') + 1,
    );
    expect(upgradedProviders.find((provider) => provider.id === 'builtin-jina')?.sort_order).toBe(11);
    expect(upgradedProviders.find((provider) => provider.id === 'builtin-cohere')?.sort_order).toBe(12);
    expect(upgradedProviders.find((provider) => provider.id === 'builtin-voyage')?.sort_order).toBe(13);
  });

  it('does not share mutable built-in provider data across initializations', async () => {
    const providers = await handleCommand<any[]>('list_providers');
    const shuaiApi = providers.find((provider) => provider.id === 'builtin-shuaiapi');
    const gptnb = providers.find((provider) => provider.id === 'builtin-gptnb');
    shuaiApi.keys.push({ id: 'temporary-key' });
    gptnb.keys.push({ id: 'temporary-key' });

    localStorage.clear();
    const reinitializedProviders = await handleCommand<any[]>('list_providers');

    expect(reinitializedProviders.find((provider) => provider.id === 'builtin-shuaiapi'))
      .toEqual(EXPECTED_SHUAI_API_PROVIDER);
    expect(reinitializedProviders.find((provider) => provider.id === 'builtin-gptnb'))
      .toEqual(EXPECTED_GPTNB_PROVIDER);
  });
});

describe('browserMock conversation ordering', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lists conversations in backend order and includes sort order', async () => {
    localStorage.setItem('aqbot_conversations', JSON.stringify([
      mockConversation('third', { sort_order: 2, updated_at: 100 }),
      mockConversation('second', { sort_order: 2, updated_at: 200 }),
      mockConversation('first', { sort_order: 0, updated_at: 50 }),
      mockConversation('pinned', { is_pinned: true, sort_order: 4, updated_at: 25 }),
      mockConversation('archived', { sort_order: -1, is_archived: true }),
    ]));

    const conversations = await handleCommand<any[]>('list_conversations');

    expect(conversations.map((conversation) => conversation.id)).toEqual([
      'pinned',
      'second',
      'third',
      'first',
    ]);
    expect(conversations.map((conversation) => conversation.sort_order)).toEqual([4, 2, 2, 0]);
  });

  it('creates conversations at the top of the uncategorized container', async () => {
    localStorage.setItem('aqbot_conversations', JSON.stringify([
      mockConversation('uncategorized', { sort_order: 3 }),
      mockConversation('categorized', { category_id: 'category', sort_order: -10 }),
    ]));

    const created = await handleCommand<any>('create_conversation', {
      title: 'Created',
      modelId: 'model',
      providerId: 'provider',
    });

    expect(created.sort_order).toBe(2);
    const persisted = JSON.parse(localStorage.getItem('aqbot_conversations') ?? '[]');
    expect(persisted.find((conversation: any) => conversation.id === 'uncategorized').sort_order).toBe(3);
    expect(persisted.find((conversation: any) => conversation.id === 'categorized').sort_order).toBe(-10);
  });

  it('defaults legacy and newly created conversation layout overrides to null', async () => {
    localStorage.setItem('aqbot_conversations', JSON.stringify([
      mockConversation('legacy', { multi_model_display_mode_override: undefined }),
    ]));

    const [legacy] = await handleCommand<any[]>('list_conversations');
    const created = await handleCommand<any>('create_conversation', {
      title: 'Created',
      modelId: 'model',
      providerId: 'provider',
    });

    expect([
      legacy.multi_model_display_mode_override,
      created.multi_model_display_mode_override,
    ]).toEqual([null, null]);
  });

  it('sets, preserves, and clears a conversation layout override', async () => {
    localStorage.setItem('aqbot_conversations', JSON.stringify([
      mockConversation('conversation'),
    ]));

    const setOverride = await handleCommand<any>('update_conversation', {
      id: 'conversation',
      input: { multi_model_display_mode_override: 'side-by-side' },
    });
    const preserved = await handleCommand<any>('update_conversation', {
      id: 'conversation',
      input: { title: 'Renamed' },
    });
    const cleared = await handleCommand<any>('update_conversation', {
      id: 'conversation',
      input: { multi_model_display_mode_override: null },
    });

    expect([
      setOverride.multi_model_display_mode_override,
      preserved.multi_model_display_mode_override,
      cleared.multi_model_display_mode_override,
    ]).toEqual(['side-by-side', 'side-by-side', null]);
  });

  it('atomically reorders a complete top-level conversation container without changing timestamps', async () => {
    const conversations = [
      mockConversation('first', { sort_order: 0, updated_at: 101 }),
      mockConversation('second', { sort_order: 1, updated_at: 202 }),
      mockConversation('child', { parent_conversation_id: 'first', sort_order: 7, updated_at: 303 }),
      mockConversation('archived', { is_archived: true, sort_order: 8, updated_at: 404 }),
      mockConversation('categorized', { category_id: 'category', sort_order: 9, updated_at: 505 }),
    ];
    localStorage.setItem('aqbot_conversations', JSON.stringify(conversations));
    localStorage.setItem('aqbot_conversation_categories', JSON.stringify([{ id: 'category' }]));

    await handleCommand('reorder_conversations', {
      categoryId: null,
      conversationIds: ['second', 'first'],
    });

    const persisted = JSON.parse(localStorage.getItem('aqbot_conversations') ?? '[]');
    expect(persisted.find((conversation: any) => conversation.id === 'second')).toMatchObject({
      sort_order: 0,
      updated_at: 202,
    });
    expect(persisted.find((conversation: any) => conversation.id === 'first')).toMatchObject({
      sort_order: 1,
      updated_at: 101,
    });
    expect(persisted.find((conversation: any) => conversation.id === 'child').sort_order).toBe(7);
    expect(persisted.find((conversation: any) => conversation.id === 'archived').sort_order).toBe(8);
    expect(persisted.find((conversation: any) => conversation.id === 'categorized').sort_order).toBe(9);
  });

  it('rejects invalid reorder payloads without persisting partial changes', async () => {
    const conversations = [
      mockConversation('first', { sort_order: 0 }),
      mockConversation('second', { sort_order: 1 }),
      mockConversation('child', { parent_conversation_id: 'first', sort_order: 2 }),
      mockConversation('categorized', { category_id: 'category', sort_order: 3 }),
    ];
    const original = JSON.stringify(conversations);
    localStorage.setItem('aqbot_conversations', original);
    localStorage.setItem('aqbot_conversation_categories', JSON.stringify([{ id: 'category' }]));

    await expect(handleCommand('reorder_conversations', {
      categoryId: null,
      conversationIds: ['first'],
    })).rejects.toThrow('every conversation');
    await expect(handleCommand('reorder_conversations', {
      categoryId: null,
      conversationIds: ['first', 'first'],
    })).rejects.toThrow('duplicates');
    await expect(handleCommand('reorder_conversations', {
      categoryId: null,
      conversationIds: ['first', 'child'],
    })).rejects.toThrow('every conversation');
    await expect(handleCommand('reorder_conversations', {
      categoryId: 'missing',
      conversationIds: [],
    })).rejects.toThrow('Category not found');

    expect(localStorage.getItem('aqbot_conversations')).toBe(original);
  });

  it('strictly reorders categorized conversations', async () => {
    localStorage.setItem('aqbot_conversations', JSON.stringify([
      mockConversation('first', { category_id: 'category', sort_order: 0, updated_at: 101 }),
      mockConversation('second', { category_id: 'category', sort_order: 1, updated_at: 202 }),
      mockConversation('uncategorized', { sort_order: 4 }),
    ]));
    localStorage.setItem('aqbot_conversation_categories', JSON.stringify([{ id: 'category' }]));

    await handleCommand('reorder_conversations', {
      categoryId: 'category',
      conversationIds: ['second', 'first'],
    });

    const persisted = JSON.parse(localStorage.getItem('aqbot_conversations') ?? '[]');
    expect(persisted.find((conversation: any) => conversation.id === 'second')).toMatchObject({
      sort_order: 0,
      updated_at: 202,
    });
    expect(persisted.find((conversation: any) => conversation.id === 'first')).toMatchObject({
      sort_order: 1,
      updated_at: 101,
    });
    expect(persisted.find((conversation: any) => conversation.id === 'uncategorized').sort_order).toBe(4);
  });

  it('moves single conversations to the top when their visible container membership changes', async () => {
    localStorage.setItem('aqbot_conversations', JSON.stringify([
      mockConversation('uncategorized-first', { sort_order: 0 }),
      mockConversation('uncategorized-moved', { sort_order: 1 }),
      mockConversation('category-first', { category_id: 'category', sort_order: 0 }),
      mockConversation('archived', { category_id: 'category', is_archived: true, sort_order: 10 }),
    ]));
    localStorage.setItem('aqbot_conversation_categories', JSON.stringify([{ id: 'category' }]));

    const moved = await handleCommand<any>('update_conversation', {
      id: 'uncategorized-moved',
      input: { category_id: 'category' },
    });
    const pinned = await handleCommand<any>('toggle_pin_conversation', {
      id: 'uncategorized-first',
    });
    const unarchived = await handleCommand<any>('toggle_archive_conversation', {
      id: 'archived',
    });

    expect(moved.sort_order).toBe(-1);
    expect(pinned.sort_order).toBe(0);
    expect(unarchived.sort_order).toBe(-2);
  });

  it('moves a deleted category into an ordered block at the uncategorized top', async () => {
    localStorage.setItem('aqbot_conversations', JSON.stringify([
      mockConversation('uncategorized', { sort_order: 0 }),
      mockConversation('category-second', { category_id: 'category', sort_order: 1 }),
      mockConversation('category-first', { category_id: 'category', sort_order: 0 }),
      mockConversation('category-child', {
        category_id: 'category',
        parent_conversation_id: 'category-first',
        sort_order: 9,
      }),
    ]));
    localStorage.setItem('aqbot_conversation_categories', JSON.stringify([{ id: 'category' }]));

    await handleCommand('delete_conversation_category', { id: 'category' });

    const persisted = JSON.parse(localStorage.getItem('aqbot_conversations') ?? '[]');
    expect(persisted.find((conversation: any) => conversation.id === 'category-first')).toMatchObject({
      category_id: null,
      sort_order: -2,
    });
    expect(persisted.find((conversation: any) => conversation.id === 'category-second')).toMatchObject({
      category_id: null,
      sort_order: -1,
    });
    expect(persisted.find((conversation: any) => conversation.id === 'category-child')).toMatchObject({
      category_id: null,
      sort_order: 9,
    });
    expect(persisted.find((conversation: any) => conversation.id === 'uncategorized').sort_order).toBe(0);
  });
});

describe('browserMock gateway templates', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns Claude and Cursor templates that match AQBot runtime contracts', async () => {
    const templates = await handleCommand<GatewayTemplate[]>('list_gateway_templates');

    const cursor = templates.find((template) => template.target === 'cursor');
    expect(cursor).toBeDefined();
    expect(cursor?.content).toContain('"openai.apiKey"');
    expect(cursor?.content).toContain('"openai.apiBaseUrl"');
    expect(cursor?.content).not.toContain('"api_key"');
    expect(cursor?.content).not.toContain('"api_base"');

    const claude = templates.find((template) => template.target === 'claude_code');
    expect(claude).toBeDefined();
    expect(claude?.content).toContain('ANTHROPIC_BASE_URL=');
    expect(claude?.content).toContain('ANTHROPIC_AUTH_TOKEN=');
    expect(claude?.content).not.toContain('ANTHROPIC_API_KEY=');
  });

  it('maps backup manifests into files-page backup rows and cleans up missing entries', async () => {
    await handleCommand('create_backup', { format: 'sqlite' });

    const rows = await handleCommand<any[]>('list_files_page_entries', { category: 'backups' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^backup_manifest::/);
    expect(rows[0].category).toBe('backups');
    expect(rows[0].path).toContain('/mock/path/');

    await handleCommand('cleanup_missing_files_page_entry', { entryId: rows[0].id });

    const backups = await handleCommand<any[]>('list_backups');
    expect(backups).toHaveLength(0);
  });

  it('exposes raw stored-file ids for files-page image protocol URLs', async () => {
    localStorage.setItem('aqbot_drawing_files', JSON.stringify([{
      id: 'stored-image-1',
      original_name: 'preview.png',
      mime_type: 'image/png',
      size_bytes: 68,
      storage_path: 'images/preview.png',
      data: 'ignored-by-files-page-list',
    }]));

    const rows = await handleCommand<any[]>('list_files_page_entries', { category: 'images' });

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'attachment::stored-image-1',
        storedFileId: 'stored-image-1',
        storagePath: 'images/preview.png',
      }),
    ]);
  });

  it('stores S3 config and supports S3 backup list/delete commands', async () => {
    await handleCommand('save_s3_config', {
      config: {
        bucket: 'aqbot-backups',
        region: 'us-west-2',
        prefix: 'desktop/',
        endpointUrl: null,
        forcePathStyle: false,
        useDefaultCredentials: false,
        accessKeyId: 'access',
        secretAccessKey: 'secret',
        sessionToken: null,
      },
    });

    const config = await handleCommand<any>('get_s3_config');
    expect(config.bucket).toBe('aqbot-backups');

    const fileName = await handleCommand<string>('s3_backup');
    const backups = await handleCommand<any[]>('s3_list_backups');
    expect(backups[0].fileName).toBe(fileName);

    await handleCommand('s3_delete_backup', { fileName });
    const remaining = await handleCommand<any[]>('s3_list_backups');
    expect(remaining).toHaveLength(0);
  });

  it('flattens MCP create input and updates only input fields', async () => {
    const created = await handleCommand<any>('create_mcp_server', {
      input: {
        name: 'Remote MCP',
        transport: 'http',
        endpoint: 'https://example.com/mcp',
        headersJson: JSON.stringify({ Authorization: 'Bearer old' }),
        enabled: false,
      },
    });

    expect(created.name).toBe('Remote MCP');
    expect(created.transport).toBe('http');
    expect(created.endpoint).toBe('https://example.com/mcp');
    expect(created.headersJson).toBe(JSON.stringify({ Authorization: 'Bearer old' }));
    expect(created.input).toBeUndefined();

    const updated = await handleCommand<any>('update_mcp_server', {
      id: created.id,
      input: {
        headersJson: JSON.stringify({ Authorization: 'Bearer new' }),
      },
    });

    expect(updated.id).toBe(created.id);
    expect(updated.headersJson).toBe(JSON.stringify({ Authorization: 'Bearer new' }));
    expect(updated.input).toBeUndefined();
  });
});
