/**
 * Browser-mode mock backend using localStorage.
 * Activated when the app runs outside Tauri (e.g. `pnpm dev` in browser).
 * Provides CRUD operations for providers, conversations, apps, settings, and gateway.
 */

function genId(): string {
  return crypto.randomUUID();
}

function nowTs(): number {
  return Date.now();
}

function getStore<T>(key: string, defaultValue: T): T {
  try {
    const data = localStorage.getItem(`aqbot_${key}`);
    return data ? JSON.parse(data) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function setStore<T>(key: string, value: T): void {
  localStorage.setItem(`aqbot_${key}`, JSON.stringify(value));
}

function generateBrowserResponse(userContent: string): string {
  const greeting = /^(你好|hi|hello|hey|嗨)/i.test(userContent.trim());
  if (greeting) {
    return '你好！我是 AQBot 的浏览器预览模式。在此模式下，我无法连接真实的 AI 服务，但你可以体验完整的聊天界面交互。\n\n如需真实 AI 对话，请通过 `cargo tauri dev` 启动 Tauri 后端。';
  }
  return `收到你的消息：「${userContent.length > 50 ? userContent.slice(0, 50) + '...' : userContent}」\n\n当前为浏览器预览模式，无法调用真实 AI 接口。此模式用于 UI 开发和体验测试。\n\n如需 AI 回复，请使用 \`cargo tauri dev\` 启动完整应用。`;
}

// ── Built-in Providers ──────────────────────────────────────────────────

const BUILT_IN_PROVIDERS = [
  {
    id: 'builtin-openai',
    name: 'OpenAI',
    provider_type: 'openai',
    api_host: 'https://api.openai.com',
    api_path: null,
    enabled: true,
    models: [
      { provider_id: 'builtin-openai', model_id: 'gpt-4o', name: 'gpt-4o', capabilities: ['TextGeneration', 'Vision', 'FunctionCalling'], max_tokens: 128000, enabled: true, param_overrides: null },
      { provider_id: 'builtin-openai', model_id: 'gpt-4o-mini', name: 'gpt-4o-mini', capabilities: ['TextGeneration', 'Vision', 'FunctionCalling'], max_tokens: 128000, enabled: true, param_overrides: null },
      { provider_id: 'builtin-openai', model_id: 'o3-mini', name: 'o3-mini', capabilities: ['TextGeneration', 'Reasoning'], max_tokens: 200000, enabled: false, param_overrides: null },
      { provider_id: 'builtin-openai', model_id: 'gpt-4.1', name: 'gpt-4.1', capabilities: ['TextGeneration', 'Vision', 'FunctionCalling'], max_tokens: 1047576, enabled: false, param_overrides: null },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 0,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: 'builtin-openai-responses',
    name: 'OpenAI Responses',
    provider_type: 'openai_responses',
    api_host: 'https://api.openai.com',
    api_path: null,
    enabled: true,
    models: [
      { provider_id: 'builtin-openai-responses', model_id: 'gpt-4o', name: 'gpt-4o', capabilities: ['TextGeneration', 'Vision', 'FunctionCalling'], max_tokens: 128000, enabled: true, param_overrides: null },
      { provider_id: 'builtin-openai-responses', model_id: 'gpt-4o-mini', name: 'gpt-4o-mini', capabilities: ['TextGeneration', 'Vision', 'FunctionCalling'], max_tokens: 128000, enabled: true, param_overrides: null },
      { provider_id: 'builtin-openai-responses', model_id: 'o3-mini', name: 'o3-mini', capabilities: ['TextGeneration', 'Reasoning'], max_tokens: 200000, enabled: false, param_overrides: null },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 1,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: 'builtin-gemini',
    name: 'Gemini',
    provider_type: 'gemini',
    api_host: 'https://generativelanguage.googleapis.com',
    api_path: null,
    enabled: true,
    models: [
      { provider_id: 'builtin-gemini', model_id: 'gemini-2.5-flash', name: 'gemini-2.5-flash', capabilities: ['TextGeneration', 'Vision', 'Reasoning'], max_tokens: 1048576, enabled: true, param_overrides: null },
      { provider_id: 'builtin-gemini', model_id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', capabilities: ['TextGeneration', 'Vision', 'Reasoning'], max_tokens: 1048576, enabled: true, param_overrides: null },
      { provider_id: 'builtin-gemini', model_id: 'gemini-2.0-flash', name: 'gemini-2.0-flash', capabilities: ['TextGeneration', 'Vision'], max_tokens: 1048576, enabled: false, param_overrides: null },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 2,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: 'builtin-anthropic',
    name: 'Claude',
    provider_type: 'anthropic',
    api_host: 'https://api.anthropic.com',
    api_path: null,
    enabled: true,
    models: [
      { provider_id: 'builtin-anthropic', model_id: 'claude-sonnet-4-20250514', name: 'claude-sonnet-4-20250514', capabilities: ['TextGeneration', 'Vision', 'FunctionCalling'], max_tokens: 200000, enabled: true, param_overrides: null },
      { provider_id: 'builtin-anthropic', model_id: 'claude-3-5-haiku-20241022', name: 'claude-3-5-haiku-20241022', capabilities: ['TextGeneration'], max_tokens: 200000, enabled: true, param_overrides: null },
      { provider_id: 'builtin-anthropic', model_id: 'claude-opus-4-20250514', name: 'claude-opus-4-20250514', capabilities: ['TextGeneration', 'Vision', 'FunctionCalling'], max_tokens: 200000, enabled: false, param_overrides: null },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 3,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: 'builtin-deepseek',
    name: 'DeepSeek',
    provider_type: 'openai',
    api_host: 'https://api.deepseek.com',
    api_path: null,
    enabled: true,
    models: [
      { provider_id: 'builtin-deepseek', model_id: 'deepseek-chat', name: 'deepseek-chat', capabilities: ['TextGeneration'], max_tokens: 128000, enabled: true, param_overrides: null },
      { provider_id: 'builtin-deepseek', model_id: 'deepseek-reasoner', name: 'deepseek-reasoner', capabilities: ['TextGeneration', 'Reasoning'], max_tokens: 128000, enabled: true, param_overrides: null },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 4,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: 'builtin-xai',
    name: 'xAI',
    provider_type: 'openai',
    api_host: 'https://api.x.ai',
    api_path: null,
    enabled: true,
    models: [
      { provider_id: 'builtin-xai', model_id: 'grok-3', name: 'grok-3', capabilities: ['TextGeneration', 'Vision', 'FunctionCalling'], max_tokens: 131072, enabled: true, param_overrides: null },
      { provider_id: 'builtin-xai', model_id: 'grok-3-mini', name: 'grok-3-mini', capabilities: ['TextGeneration', 'Vision', 'Reasoning'], max_tokens: 131072, enabled: true, param_overrides: null },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 5,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: 'builtin-glm',
    name: 'GLM',
    provider_type: 'openai',
    api_host: 'https://open.bigmodel.cn/api/paas',
    api_path: null,
    enabled: true,
    models: [
      { provider_id: 'builtin-glm', model_id: 'glm-4-plus', name: 'glm-4-plus', capabilities: ['TextGeneration', 'Vision', 'FunctionCalling'], max_tokens: 128000, enabled: true, param_overrides: null },
      { provider_id: 'builtin-glm', model_id: 'glm-4-flash', name: 'glm-4-flash', capabilities: ['TextGeneration', 'Vision'], max_tokens: 128000, enabled: true, param_overrides: null },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 6,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: 'builtin-minimax',
    name: 'MiniMax',
    provider_type: 'openai',
    api_host: 'https://api.minimaxi.com',
    api_path: null,
    enabled: true,
    models: [
      { provider_id: 'builtin-minimax', model_id: 'MiniMax-M1', name: 'MiniMax-M1', capabilities: ['TextGeneration', 'Reasoning'], max_tokens: 1000000, enabled: true, param_overrides: null },
      { provider_id: 'builtin-minimax', model_id: 'MiniMax-S1', name: 'MiniMax-S1', capabilities: ['TextGeneration'], max_tokens: 245760, enabled: true, param_overrides: null },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 7,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
];

function initProviders(): any[] {
  const existing = getStore<any[]>('providers', []);
  if (existing.length === 0) {
    setStore('providers', BUILT_IN_PROVIDERS);
    return [...BUILT_IN_PROVIDERS];
  }
  // Restore missing models for built-in providers (e.g. after a bad fetch_remote_models wipe)
  let dirty = false;
  for (const builtin of BUILT_IN_PROVIDERS) {
    const stored = existing.find((p: any) => p.id === builtin.id);
    if (stored && (!stored.models || stored.models.length === 0)) {
      stored.models = [...builtin.models];
      dirty = true;
    }
  }
  if (dirty) setStore('providers', existing);
  return existing;
}

// ── Default Settings ────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  theme_mode: 'system',
  primary_color: '#17A93D',
  font_size: 14,
  language: 'zh-CN',
  send_on_enter: true,
  stream_response: true,
  global_shortcut: 'CmdOrCtrl+Shift+A',
  shortcut_toggle_current_window: 'CmdOrCtrl+Shift+A',
  shortcut_toggle_all_windows: 'CmdOrCtrl+Shift+Alt+A',
  shortcut_close_window: 'CmdOrCtrl+Shift+W',
  shortcut_new_conversation: 'CmdOrCtrl+N',
  shortcut_open_settings: 'CmdOrCtrl+,',
  shortcut_toggle_model_selector: 'CmdOrCtrl+Shift+M',
  shortcut_fill_last_message: 'CmdOrCtrl+Shift+ArrowUp',
  shortcut_clear_context: 'CmdOrCtrl+Shift+K',
  shortcut_clear_conversation_messages: 'CmdOrCtrl+Shift+Backspace',
  shortcut_toggle_gateway: 'CmdOrCtrl+Shift+G',
  global_shortcuts_enabled: true,
  shortcut_registration_logs_enabled: false,
  shortcut_trigger_toast_enabled: false,
  proxy_enabled: false,
  proxy_url: '',
  auto_backup: false,
  backup_interval_hours: 24,
  content_safety_enabled: true,
  last_selected_conversation_id: null,
};

// ── Command Handler ─────────────────────────────────────────────────────

export async function handleCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise((r) => setTimeout(r, 5));

  switch (cmd) {
    // ── Settings ──────────────────────────────────────────────────────
    case 'get_settings':
      return getStore('settings', DEFAULT_SETTINGS) as T;
    case 'save_settings': {
      const settings = (args as any)?.settings;
      const current = getStore('settings', DEFAULT_SETTINGS);
      const merged = { ...current, ...settings };
      setStore('settings', merged);
      return merged as T;
    }

    // ── Providers ─────────────────────────────────────────────────────
    case 'list_providers':
      return initProviders() as T;
    case 'create_provider': {
      const input = (args as any)?.input;
      const id = genId();
      const now = nowTs();
      const provider = {
        id,
        name: input.name,
        provider_type: input.provider_type,
        api_host: input.api_host,
        enabled: input.enabled ?? true,
        models: [],
        keys: [],
        proxy_config: null,
        created_at: now,
        updated_at: now,
      };
      const providers = getStore<any[]>('providers', []);
      providers.push(provider);
      setStore('providers', providers);
      return provider as T;
    }
    case 'update_provider': {
      const { id, input } = args as any;
      const providers = getStore<any[]>('providers', []);
      const idx = providers.findIndex((p: any) => p.id === id);
      if (idx === -1) throw new Error('Provider not found');
      const { api_path, sort_order, ...rest } = input;
      providers[idx] = { ...providers[idx], ...rest, updated_at: nowTs() };
      if (api_path !== undefined) providers[idx].api_path = api_path;
      if (sort_order !== undefined) providers[idx].sort_order = sort_order;
      setStore('providers', providers);
      return providers[idx] as T;
    }
    case 'delete_provider': {
      const { id } = args as any;
      const providers = getStore<any[]>('providers', []).filter((p: any) => p.id !== id);
      setStore('providers', providers);
      return undefined as T;
    }
    case 'reorder_providers': {
      const { providerIds } = args as any;
      const providers = getStore<any[]>('providers', []);
      for (let i = 0; i < providerIds.length; i++) {
        const p = providers.find((p: any) => p.id === providerIds[i]);
        if (p) p.sort_order = i;
      }
      providers.sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      setStore('providers', providers);
      return undefined as T;
    }
    case 'toggle_provider': {
      const { id, enabled } = args as any;
      const providers = getStore<any[]>('providers', []);
      const idx = providers.findIndex((p: any) => p.id === id);
      if (idx !== -1) {
        providers[idx].enabled = enabled;
        providers[idx].updated_at = nowTs();
        setStore('providers', providers);
      }
      return undefined as T;
    }
    case 'add_provider_key': {
      const { providerId, rawKey } = args as any;
      const key = {
        id: genId(),
        provider_id: providerId,
        key_encrypted: rawKey,
        key_prefix: rawKey.substring(0, 8) + '...',
        enabled: true,
        last_validated_at: null,
        last_error: null,
        rotation_index: 0,
        created_at: nowTs(),
      };
      const providers = getStore<any[]>('providers', []);
      const idx = providers.findIndex((p: any) => p.id === providerId);
      if (idx !== -1) {
        providers[idx].keys.push(key);
        setStore('providers', providers);
      }
      return key as T;
    }
    case 'delete_provider_key': {
      const { keyId } = args as any;
      const providers = getStore<any[]>('providers', []);
      for (const p of providers) {
        p.keys = p.keys.filter((k: any) => k.id !== keyId);
      }
      setStore('providers', providers);
      return undefined as T;
    }
    case 'toggle_provider_key': {
      const { keyId, enabled } = args as any;
      const providers = getStore<any[]>('providers', []);
      for (const p of providers) {
        const key = p.keys.find((k: any) => k.id === keyId);
        if (key) key.enabled = enabled;
      }
      setStore('providers', providers);
      return undefined as T;
    }
    case 'validate_provider_key':
      return true as T;
    case 'save_models': {
      const { providerId, models } = args as any;
      const providers = getStore<any[]>('providers', []);
      const idx = providers.findIndex((p: any) => p.id === providerId);
      if (idx !== -1) {
        providers[idx].models = models;
        setStore('providers', providers);
      }
      return undefined as T;
    }
    case 'toggle_model': {
      const { providerId, modelId, enabled } = args as any;
      const providers = getStore<any[]>('providers', []);
      const pIdx = providers.findIndex((p: any) => p.id === providerId);
      if (pIdx !== -1) {
        const model = providers[pIdx].models.find((m: any) => m.model_id === modelId);
        if (model) {
          model.enabled = enabled;
          setStore('providers', providers);
          return model as T;
        }
      }
      throw new Error('Model not found');
    }
    case 'update_model_params': {
      const { providerId, modelId, overrides } = args as any;
      const providers = getStore<any[]>('providers', []);
      const pIdx = providers.findIndex((p: any) => p.id === providerId);
      if (pIdx !== -1) {
        const model = providers[pIdx].models.find((m: any) => m.model_id === modelId);
        if (model) {
          model.param_overrides = overrides;
          setStore('providers', providers);
          return model as T;
        }
      }
      throw new Error('Model not found');
    }
    case 'fetch_remote_models': {
      const providers = getStore('providers', []) as any[];
      const target = providers.find((p: any) => p.id === (args as any).providerId);
      return (target?.models ?? []) as T;
    }

    // ── Conversations ─────────────────────────────────────────────────
    case 'list_conversations':
      return getStore('conversations', []).filter((c: any) => !c.is_archived) as T;
    case 'list_archived_conversations':
      return getStore('conversations', []).filter((c: any) => c.is_archived) as T;
    case 'create_conversation': {
      const { title, modelId, providerId } = args as any;
      const conv = {
        id: genId(),
        title,
        model_id: modelId,
        provider_id: providerId,
        system_prompt: null,
        temperature: null,
        max_tokens: null,
        top_p: null,
        frequency_penalty: null,
        search_enabled: false,
        search_provider_id: null,
        thinking_budget: null,
        enabled_mcp_server_ids: [],
        enabled_knowledge_base_ids: [],
        enabled_memory_namespace_ids: [],
        message_count: 0,
        is_pinned: false,
        is_archived: false,
        created_at: nowTs(),
        updated_at: nowTs(),
      };
      const convs = getStore<any[]>('conversations', []);
      convs.push(conv);
      setStore('conversations', convs);
      return conv as T;
    }
    case 'update_conversation': {
      const { id, input } = args as any;
      const convs = getStore<any[]>('conversations', []);
      const idx = convs.findIndex((c: any) => c.id === id);
      if (idx !== -1) {
        convs[idx] = { ...convs[idx], ...input, updated_at: nowTs() };
        setStore('conversations', convs);
        return convs[idx] as T;
      }
      throw new Error('Conversation not found');
    }
    case 'delete_conversation': {
      const { id } = args as any;
      const convs = getStore<any[]>('conversations', []).filter((c: any) => c.id !== id);
      setStore('conversations', convs);
      const msgs = getStore<any[]>('messages', []).filter((m: any) => m.conversation_id !== id);
      setStore('messages', msgs);
      return undefined as T;
    }
    case 'toggle_pin_conversation': {
      const { id } = args as any;
      const convs = getStore<any[]>('conversations', []);
      const idx = convs.findIndex((c: any) => c.id === id);
      if (idx !== -1) {
        convs[idx].is_pinned = !convs[idx].is_pinned;
        convs[idx].updated_at = nowTs();
        setStore('conversations', convs);
        return convs[idx] as T;
      }
      throw new Error('Conversation not found');
    }
    case 'toggle_archive_conversation': {
      const { id } = args as any;
      const convs = getStore<any[]>('conversations', []);
      const aidx = convs.findIndex((c: any) => c.id === id);
      if (aidx !== -1) {
        convs[aidx].is_archived = !convs[aidx].is_archived;
        convs[aidx].updated_at = nowTs();
        setStore('conversations', convs);
        return convs[aidx] as T;
      }
      throw new Error('Conversation not found');
    }
    case 'list_conversation_categories':
      return getStore<any[]>('conversation_categories', []) as T;
    case 'create_conversation_category': {
      const { input } = args as any;
      const cats = getStore<any[]>('conversation_categories', []);
      const maxOrder = cats.reduce((m: number, c: any) => Math.max(m, c.sort_order ?? 0), -1);
      const cat = {
        id: genId(),
        name: input.name,
        icon_type: input.icon_type ?? null,
        icon_value: input.icon_value ?? null,
        sort_order: maxOrder + 1,
        is_collapsed: true,
        created_at: nowTs(),
        updated_at: nowTs(),
      };
      cats.push(cat);
      setStore('conversation_categories', cats);
      return cat as T;
    }
    case 'update_conversation_category': {
      const { id, input } = args as any;
      const cats = getStore<any[]>('conversation_categories', []);
      const idx = cats.findIndex((c: any) => c.id === id);
      if (idx !== -1) {
        if (input.name !== undefined) cats[idx].name = input.name;
        if (input.icon_type !== undefined) cats[idx].icon_type = input.icon_type;
        if (input.icon_value !== undefined) cats[idx].icon_value = input.icon_value;
        cats[idx].updated_at = nowTs();
        setStore('conversation_categories', cats);
        return cats[idx] as T;
      }
      throw new Error('Category not found');
    }
    case 'delete_conversation_category': {
      const { id } = args as any;
      const cats = getStore<any[]>('conversation_categories', []).filter((c: any) => c.id !== id);
      setStore('conversation_categories', cats);
      const convs = getStore<any[]>('conversations', []);
      convs.forEach((c: any) => { if (c.category_id === id) c.category_id = null; });
      setStore('conversations', convs);
      return undefined as T;
    }
    case 'reorder_conversation_categories': {
      const { categoryIds } = args as any;
      const cats = getStore<any[]>('conversation_categories', []);
      for (let i = 0; i < categoryIds.length; i++) {
        const c = cats.find((c: any) => c.id === categoryIds[i]);
        if (c) c.sort_order = i;
      }
      cats.sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      setStore('conversation_categories', cats);
      return undefined as T;
    }
    case 'set_conversation_category_collapsed': {
      const { id, collapsed } = args as any;
      const cats = getStore<any[]>('conversation_categories', []);
      const idx = cats.findIndex((c: any) => c.id === id);
      if (idx !== -1) {
        cats[idx].is_collapsed = collapsed;
        cats[idx].updated_at = nowTs();
        setStore('conversation_categories', cats);
      }
      return undefined as T;
    }
    case 'send_message': {
      const { conversationId, content, attachments } = args as any;
      const userMsgId = genId();
      const userMsg = {
        id: userMsgId,
        conversation_id: conversationId,
        role: 'user',
        content,
        thinking: null,
        attachments: attachments || [],
        created_at: nowTs(),
        parent_message_id: null,
        version_index: 0,
        is_active: true,
      };
      const msgs = getStore<any[]>('messages', []);
      msgs.push(userMsg);

      // Generate a simulated AI response in browser mode
      const aiMsg = {
        id: genId(),
        conversation_id: conversationId,
        role: 'assistant',
        content: generateBrowserResponse(content),
        thinking: null,
        attachments: [],
        created_at: nowTs() + 1,
        parent_message_id: userMsgId,
        version_index: 0,
        is_active: true,
      };
      msgs.push(aiMsg);
      setStore('messages', msgs);
      return userMsg as T;
    }
    case 'list_messages': {
      const { conversationId } = args as any;
      const msgs = getStore<any[]>('messages', []).filter(
        (m: any) => m.conversation_id === conversationId,
      );
      return msgs as T;
    }
    case 'list_messages_page': {
      const { conversationId, limit = 10, beforeMessageId = null } = args as any;
      const allMessages = getStore<any[]>('messages', [])
        .filter((m: any) => m.conversation_id === conversationId)
        .sort((a: any, b: any) => a.created_at - b.created_at);
      const cursorIndex = beforeMessageId
        ? allMessages.findIndex((m: any) => m.id === beforeMessageId)
        : allMessages.length;
      const endIndex = cursorIndex >= 0 ? cursorIndex : allMessages.length;
      const startIndex = Math.max(0, endIndex - limit);
      const pageMessages = allMessages.slice(startIndex, endIndex);
      return {
        messages: pageMessages,
        has_older: startIndex > 0,
        oldest_message_id: pageMessages[0]?.id ?? null,
      } as T;
    }
    case 'search_conversations': {
      const { query } = args as any;
      const convs = getStore<any[]>('conversations', []);
      const results = convs
        .filter((c: any) => c.title.toLowerCase().includes(query.toLowerCase()))
        .map((c: any) => ({ conversation_id: c.id, title: c.title, snippet: '' }));
      return results as T;
    }
    case 'regenerate_message': {
      const { conversationId: regenConvId } = args as any;
      const regenMsgs = getStore<any[]>('messages', []);
      const convMsgs = regenMsgs.filter((m: any) => m.conversation_id === regenConvId);
      // Find the last user message
      let lastUserMsg: any = null;
      for (let i = convMsgs.length - 1; i >= 0; i--) {
        if (convMsgs[i].role === 'user') { lastUserMsg = convMsgs[i]; break; }
      }
      if (lastUserMsg) {
        // Find existing AI versions for this user message
        const existingVersions = regenMsgs.filter(
          (m: any) => m.parent_message_id === lastUserMsg.id && m.role === 'assistant'
        );
        const nextVersion = existingVersions.length;
        // Set old AI messages for this parent to inactive
        for (const m of regenMsgs) {
          if (m.parent_message_id === lastUserMsg.id && m.role === 'assistant') {
            m.is_active = false;
          }
        }
        // Create new AI version
        const newAiMsg = {
          id: genId(),
          conversation_id: regenConvId,
          role: 'assistant',
          content: generateBrowserResponse(lastUserMsg.content),
          thinking: null,
          attachments: [],
          created_at: nowTs(),
          parent_message_id: lastUserMsg.id,
          version_index: nextVersion,
          is_active: true,
        };
        regenMsgs.push(newAiMsg);
        setStore('messages', regenMsgs);
      }
      return undefined as T;
    }
    case 'list_message_versions': {
      const { parentMessageId } = args as any;
      const allMsgs = getStore<any[]>('messages', []);
      return allMsgs.filter((m: any) => m.parent_message_id === parentMessageId) as T;
    }
    case 'switch_message_version': {
      const { parentMessageId: switchParent, messageId: switchTarget } = args as any;
      const switchMsgs = getStore<any[]>('messages', []);
      for (const m of switchMsgs) {
        if (m.parent_message_id === switchParent && m.role === 'assistant') {
          m.is_active = m.id === switchTarget;
        }
      }
      setStore('messages', switchMsgs);
      return undefined as T;
    }
    case 'delete_message_group': {
      const { userMessageId } = args as any;
      const delMsgs = getStore<any[]>('messages', []);
      const filtered = delMsgs.filter(
        (m: any) => m.id !== userMessageId && m.parent_message_id !== userMessageId
      );
      setStore('messages', filtered);
      return undefined as T;
    }

    // ── Gateway ───────────────────────────────────────────────────────
    case 'list_gateway_keys':
      return getStore('gateway_keys', []) as T;
    case 'create_gateway_key': {
      const { input } = args as any;
      const key = {
        id: genId(),
        ...input,
        key: `gk-${genId().substring(0, 16)}`,
        created_at: nowTs(),
        last_used_at: null,
        total_requests: 0,
      };
      const keys = getStore<any[]>('gateway_keys', []);
      keys.push(key);
      setStore('gateway_keys', keys);
      return { gateway_key: key, plain_key: `sk-mock-plain-key-${genId().substring(0, 8)}` } as T;
    }
    case 'delete_gateway_key': {
      const { id } = args as any;
      const keys = getStore<any[]>('gateway_keys', []).filter((k: any) => k.id !== id);
      setStore('gateway_keys', keys);
      return undefined as T;
    }
    case 'toggle_gateway_key': {
      const { id, enabled } = args as any;
      const keys = getStore<any[]>('gateway_keys', []);
      const idx = keys.findIndex((k: any) => k.id === id);
      if (idx !== -1) {
        keys[idx].enabled = enabled;
        setStore('gateway_keys', keys);
      }
      return undefined as T;
    }
    case 'get_gateway_metrics':
      return {
        total_requests: 0,
        successful_requests: 0,
        failed_requests: 0,
        avg_latency_ms: 0,
        requests_per_minute: 0,
        active_keys: 0,
        uptime_seconds: 0,
      } as T;
    case 'get_gateway_usage_by_key':
    case 'get_gateway_usage_by_provider':
    case 'get_gateway_usage_by_day':
      return [] as T;
    case 'get_gateway_status':
      return {
        is_running: false,
        listen_address: '127.0.0.1',
        port: 3000,
        ssl_enabled: false,
        started_at: null,
        https_port: null,
        force_ssl: false,
      } as T;
    case 'get_connected_programs':
      return [] as T;
    case 'start_gateway':
    case 'stop_gateway':
      return undefined as T;

    // ── Data management ───────────────────────────────────────────────
    case 'export_data':
      return { path: 'export.json' } as T;
    case 'import_data':
      return undefined as T;
    case 'clear_data':
      localStorage.clear();
      return undefined as T;

    // ── Phase 2: Search Providers ──────────────────────────────────────
    case 'list_search_providers':
      return getStore('search_providers', []) as T;
    case 'create_search_provider': {
      const sps = getStore<any[]>('search_providers', []);
      const spInput = (args as any)?.input ?? args;
      const sp = { id: genId(), ...spInput, hasApiKey: !!spInput?.apiKey, created_at: nowTs(), updated_at: nowTs() };
      delete sp.apiKey;
      sps.push(sp);
      setStore('search_providers', sps);
      return sp as T;
    }
    case 'update_search_provider': {
      const sps2 = getStore<any[]>('search_providers', []);
      const spUpdateId = (args as any)?.id;
      const spInput = (args as any)?.input ?? {};
      const spi = sps2.findIndex(s => s.id === spUpdateId);
      if (spi >= 0) {
        const { apiKey, ...rest } = spInput;
        Object.assign(sps2[spi], rest, { updated_at: nowTs() });
        if (apiKey !== undefined) {
          sps2[spi].hasApiKey = !!apiKey;
        }
        setStore('search_providers', sps2);
        return sps2[spi] as T;
      }
      return undefined as T;
    }
    case 'delete_search_provider': {
      const sps3 = getStore<any[]>('search_providers', []);
      setStore('search_providers', sps3.filter(s => s.id !== (args as any)?.id));
      return undefined as T;
    }
    case 'test_search_provider':
      return { ok: true, latency_ms: 120 } as T;

    // ── Phase 2: MCP Servers ──────────────────────────────────────────
    case 'list_mcp_servers':
      return getStore('mcp_servers', []) as T;
    case 'create_mcp_server': {
      const mcps = getStore<any[]>('mcp_servers', []);
      const mcp = { id: genId(), ...(args as any), status: 'disconnected', created_at: nowTs(), updated_at: nowTs() };
      mcps.push(mcp);
      setStore('mcp_servers', mcps);
      return mcp as T;
    }
    case 'update_mcp_server': {
      const mcps2 = getStore<any[]>('mcp_servers', []);
      const mi = mcps2.findIndex(m => m.id === (args as any)?.id);
      if (mi >= 0) { Object.assign(mcps2[mi], args, { updated_at: nowTs() }); setStore('mcp_servers', mcps2); return mcps2[mi] as T; }
      return undefined as T;
    }
    case 'delete_mcp_server': {
      const mcps3 = getStore<any[]>('mcp_servers', []);
      setStore('mcp_servers', mcps3.filter(m => m.id !== (args as any)?.id));
      return undefined as T;
    }
    case 'connect_mcp_server':
      return { status: 'connected' } as T;
    case 'disconnect_mcp_server':
      return { status: 'disconnected' } as T;
    case 'list_mcp_tools':
      return [
        { name: 'web_search', description: 'Search the web', parameters: {} },
        { name: 'calculator', description: 'Evaluate math expressions', parameters: {} },
      ] as T;
    case 'execute_tool':
      return { success: true, output: `Mock result for tool "${(args as any)?.tool_name ?? 'unknown'}"` } as T;
    case 'test_mcp_server':
      return { ok: true, error: undefined } as T;
    case 'list_tool_executions':
      return [] as T;

    // ── Phase 2: Knowledge Base ───────────────────────────────────────
    case 'list_knowledge_bases':
      return getStore('knowledge_bases', []) as T;
    case 'create_knowledge_base': {
      const kbs = getStore<any[]>('knowledge_bases', []);
      const kb = { id: genId(), ...(args as any), documents: [], created_at: nowTs(), updated_at: nowTs() };
      kbs.push(kb);
      setStore('knowledge_bases', kbs);
      return kb as T;
    }
    case 'update_knowledge_base': {
      const kbs2 = getStore<any[]>('knowledge_bases', []);
      const ki = kbs2.findIndex(k => k.id === (args as any)?.id);
      if (ki >= 0) { Object.assign(kbs2[ki], args, { updated_at: nowTs() }); setStore('knowledge_bases', kbs2); return kbs2[ki] as T; }
      return undefined as T;
    }
    case 'delete_knowledge_base': {
      const kbs3 = getStore<any[]>('knowledge_bases', []);
      setStore('knowledge_bases', kbs3.filter(k => k.id !== (args as any)?.id));
      return undefined as T;
    }
    case 'add_knowledge_document': {
      const kbs4 = getStore<any[]>('knowledge_bases', []);
      const kbi = kbs4.findIndex(k => k.id === (args as any)?.baseId);
      if (kbi >= 0) {
        const doc = { id: genId(), ...(args as any), created_at: nowTs() };
        kbs4[kbi].documents = [...(kbs4[kbi].documents || []), doc];
        kbs4[kbi].updated_at = nowTs();
        setStore('knowledge_bases', kbs4);
        return doc as T;
      }
      return undefined as T;
    }
    case 'list_knowledge_documents': {
      const kbs5 = getStore<any[]>('knowledge_bases', []);
      const target = kbs5.find(k => k.id === (args as any)?.baseId);
      return (target?.documents ?? []) as T;
    }
    case 'delete_knowledge_document': {
      const kbs6 = getStore<any[]>('knowledge_bases', []);
      const delDocId = (args as any)?.id;
      for (const kb of kbs6) {
        const docs = kb.documents || [];
        const filtered = docs.filter((d: any) => d.id !== delDocId);
        if (filtered.length !== docs.length) {
          kb.documents = filtered;
          kb.updated_at = nowTs();
          break;
        }
      }
      setStore('knowledge_bases', kbs6);
      return undefined as T;
    }
    case 'query_knowledge':
    case 'search_knowledge_base':
      return [] as T;
    case 'rebuild_knowledge_index':
    case 'clear_knowledge_index':
      return undefined as T;

    // ── Phase 2: Memory ───────────────────────────────────────────────
    case 'list_memory_namespaces':
      return getStore('memory_namespaces', []) as T;
    case 'create_memory_namespace': {
      const mns = getStore<any[]>('memory_namespaces', []);
      const mn = { id: genId(), ...(args as any), items: [], created_at: nowTs(), updated_at: nowTs() };
      mns.push(mn);
      setStore('memory_namespaces', mns);
      return mn as T;
    }
    case 'delete_memory_namespace': {
      const mns2 = getStore<any[]>('memory_namespaces', []);
      setStore('memory_namespaces', mns2.filter(n => n.id !== (args as any)?.id));
      return undefined as T;
    }
    case 'add_memory_item': {
      const mns3 = getStore<any[]>('memory_namespaces', []);
      const inputMem = (args as any)?.input ?? args;
      const mni = mns3.findIndex(n => n.id === inputMem?.namespaceId);
      if (mni >= 0) {
        const item = { id: genId(), ...inputMem, created_at: nowTs() };
        mns3[mni].items = [...(mns3[mni].items || []), item];
        mns3[mni].updated_at = nowTs();
        setStore('memory_namespaces', mns3);
        return item as T;
      }
      return undefined as T;
    }
    case 'list_memory_items': {
      const mns4 = getStore<any[]>('memory_namespaces', []);
      const ns = mns4.find(n => n.id === (args as any)?.namespaceId);
      return (ns?.items ?? []) as T;
    }
    case 'delete_memory_item': {
      const mns5 = getStore<any[]>('memory_namespaces', []);
      const delItemId = (args as any)?.id;
      for (const mns of mns5) {
        const items = mns.items || [];
        const filtered = items.filter((i: any) => i.id !== delItemId);
        if (filtered.length !== items.length) {
          mns.items = filtered;
          mns.updated_at = nowTs();
          break;
        }
      }
      setStore('memory_namespaces', mns5);
      return undefined as T;
    }
    case 'recall_memory':
    case 'search_memory':
      return [] as T;
    case 'rebuild_memory_index':
    case 'clear_memory_index':
      return undefined as T;

    // ── Phase 2: Artifacts ────────────────────────────────────────────
    case 'list_artifacts': {
      const allArtifacts = getStore('artifacts', []);
      const convId = (args as any)?.conversation_id;
      return (convId ? allArtifacts.filter((a: any) => a.conversation_id === convId) : allArtifacts) as T;
    }
    case 'create_artifact': {
      const arts = getStore<any[]>('artifacts', []);
      const art = { id: genId(), ...(args as any), created_at: nowTs(), updated_at: nowTs() };
      arts.push(art);
      setStore('artifacts', arts);
      return art as T;
    }
    case 'update_artifact': {
      const arts2 = getStore<any[]>('artifacts', []);
      const ai = arts2.findIndex(a => a.id === (args as any)?.id);
      if (ai >= 0) { Object.assign(arts2[ai], args, { updated_at: nowTs() }); setStore('artifacts', arts2); return arts2[ai] as T; }
      return undefined as T;
    }
    case 'delete_artifact': {
      const arts3 = getStore<any[]>('artifacts', []);
      setStore('artifacts', arts3.filter(a => a.id !== (args as any)?.id));
      return undefined as T;
    }

    // ── Phase 2: Conversation Branching ───────────────────────────────
    case 'fork_conversation': {
      const convs = getStore<any[]>('conversations', []);
      const source = convs.find(c => c.id === (args as any)?.conversation_id);
      if (source) {
        const forked = { ...JSON.parse(JSON.stringify(source)), id: genId(), parent_id: source.id, title: (args as any)?.title ?? `Fork of ${source.title}`, created_at: nowTs(), updated_at: nowTs() };
        convs.push(forked);
        setStore('conversations', convs);
        return forked as T;
      }
      return undefined as T;
    }
    case 'list_branches': {
      const convs2 = getStore<any[]>('conversations', []);
      const parentId = (args as any)?.conversation_id;
      return convs2.filter(c => c.parent_id === parentId || c.id === parentId) as T;
    }
    case 'compare_branches': {
      const brA = (args as any)?.branch_a;
      const brB = (args as any)?.branch_b;
      return { branch_a: brA, branch_b: brB, differences: [] } as T;
    }

    // ── Phase 2: Context Sources ──────────────────────────────────────
    case 'list_context_sources':
      return getStore('context_sources', []) as T;
    case 'add_context_source': {
      const css = getStore<any[]>('context_sources', []);
      const cs = { id: genId(), ...(args as any), enabled: true, created_at: nowTs(), updated_at: nowTs() };
      css.push(cs);
      setStore('context_sources', css);
      return cs as T;
    }
    case 'remove_context_source': {
      const css2 = getStore<any[]>('context_sources', []);
      setStore('context_sources', css2.filter(c => c.id !== (args as any)?.id));
      return undefined as T;
    }
    case 'toggle_context_source': {
      const css3 = getStore<any[]>('context_sources', []);
      const csi = css3.findIndex(c => c.id === (args as any)?.id);
      if (csi >= 0) { css3[csi].enabled = !css3[csi].enabled; css3[csi].updated_at = nowTs(); setStore('context_sources', css3); return css3[csi] as T; }
      return undefined as T;
    }

    // ── Phase 2: Backup ──────────────────────────────────────────────
    case 'create_backup': {
      const bkps = getStore<any[]>('backups', []);
      const bkp = {
        id: genId(),
        version: (args as any)?.format || 'json',
        createdAt: new Date().toISOString(),
        encrypted: false,
        checksum: 'mock-checksum',
        objectCountsJson: '{}',
        sourceAppVersion: '0.1.0',
        filePath: '/mock/path/aqbot-backup.json',
        fileSize: 1024,
      };
      bkps.push(bkp);
      setStore('backups', bkps);
      return bkp as T;
    }
    case 'list_backups':
      return getStore('backups', []) as T;
    case 'delete_backup': {
      const backups = getStore('backups', []);
      const bkpId = (args as any)?.backupId;
      setStore('backups', backups.filter((b: any) => b.id !== bkpId));
      return undefined as T;
    }
    case 'batch_delete_backups': {
      const allBkps = getStore<any[]>('backups', []);
      const idsToDelete = (args as any)?.backupIds || [];
      setStore('backups', allBkps.filter((b: any) => !idsToDelete.includes(b.id)));
      return undefined as T;
    }
    case 'restore_backup':
      return undefined as T;
    case 'get_backup_settings':
      return { enabled: false, intervalHours: 24, maxCount: 10, backupDir: '/mock/backups' } as T;
    case 'update_backup_settings':
      return undefined as T;

    // ── Files Page ─────────────────────────────────────────────────────
    case 'list_files_page_entries': {
      const category = (args as any)?.category;
      if (category === 'backups') {
        const backups = getStore<any[]>('backups', []);
        return backups.map((backup: any) => ({
          id: `backup_manifest::${backup.id}`,
          name: backup.filePath?.split('/').pop() || `backup-${backup.createdAt}.${backup.version}`,
          path: backup.filePath || '',
          size: backup.fileSize,
          createdAt: backup.createdAt,
          category: 'backups',
          hasThumbnail: false,
          missing: !backup.filePath,
        })) as T;
      }
      return [] as T;
    }
    case 'open_files_page_entry':
    case 'reveal_files_page_entry':
      return undefined as T;
    case 'cleanup_missing_files_page_entry': {
      const entryId = (args as any)?.entryId as string | undefined;
      if (entryId?.startsWith('backup_manifest::')) {
        const backupId = entryId.slice('backup_manifest::'.length);
        const backups = getStore<any[]>('backups', []);
        setStore('backups', backups.filter((b: any) => b.id !== backupId));
      }
      return undefined as T;
    }

    // ── Phase 2: Program Policies ─────────────────────────────────────
    case 'list_program_policies':
      return getStore('program_policies', []) as T;
    case 'get_program_policies':
      return getStore('program_policies', []) as T;
    case 'save_program_policy': {
      const sppList = getStore<any[]>('program_policies', []);
      const sppInput = (args as any)?.input ?? args;
      const sppIdx = sppList.findIndex(p => p.programName === sppInput.programName);
      if (sppIdx >= 0) {
        Object.assign(sppList[sppIdx], sppInput, { updated_at: nowTs() });
        setStore('program_policies', sppList);
        return sppList[sppIdx] as T;
      }
      const sppNew = { id: genId(), ...sppInput, created_at: nowTs(), updated_at: nowTs() };
      sppList.push(sppNew);
      setStore('program_policies', sppList);
      return sppNew as T;
    }
    case 'create_program_policy': {
      const pps = getStore<any[]>('program_policies', []);
      const pp = { id: genId(), ...(args as any), created_at: nowTs(), updated_at: nowTs() };
      pps.push(pp);
      setStore('program_policies', pps);
      return pp as T;
    }
    case 'update_program_policy': {
      const pps2 = getStore<any[]>('program_policies', []);
      const ppi = pps2.findIndex(p => p.id === (args as any)?.id);
      if (ppi >= 0) { Object.assign(pps2[ppi], args, { updated_at: nowTs() }); setStore('program_policies', pps2); return pps2[ppi] as T; }
      return undefined as T;
    }
    case 'delete_program_policy': {
      const pps3 = getStore<any[]>('program_policies', []);
      setStore('program_policies', pps3.filter(p => p.id !== (args as any)?.id));
      return undefined as T;
    }

    // ── Phase 2: Gateway Diagnostics & Templates ──────────────────────
    case 'get_gateway_diagnostics':
      return [
        { id: '1', category: 'port', status: 'ok', message: 'Gateway port is available', createdAt: nowTs() },
        { id: '2', category: 'auth', status: 'ok', message: 'Authentication configured', createdAt: nowTs() },
        { id: '3', category: 'proxy', status: 'ok', message: 'Proxy settings valid', createdAt: nowTs() },
        { id: '4', category: 'provider_latency', status: 'warning', message: 'No providers configured', createdAt: nowTs() },
      ] as T;
    case 'list_gateway_templates':
      return getStore('gateway_templates', [
        { id: 'tpl-cursor', name: 'Cursor IDE', target: 'cursor', format: 'json', content: '{\n  "openai.apiKey": "{{key}}",\n  "openai.apiBaseUrl": "http://localhost:{{port}}/v1"\n}', copyHint: '添加到 Cursor User settings.json', created_at: nowTs(), updated_at: nowTs() },
        { id: 'tpl-vscode', name: 'VS Code Continue', target: 'vscode', format: 'json', content: '{\n  "models": [{\n    "provider": "openai",\n    "apiBase": "http://localhost:{{port}}/v1",\n    "apiKey": "{{key}}"\n  }]\n}', copyHint: '添加到 .continue/config.json 的 models 数组', created_at: nowTs(), updated_at: nowTs() },
        { id: 'tpl-claude', name: 'Claude Code CLI', target: 'claude_code', format: 'text', content: 'ANTHROPIC_BASE_URL=http://localhost:{{port}}/v1\nANTHROPIC_AUTH_TOKEN={{key}}', copyHint: '添加到环境变量或 .env 文件', created_at: nowTs(), updated_at: nowTs() },
        { id: 'tpl-openai', name: 'OpenAI Compatible', target: 'openai_compatible', format: 'text', content: 'API Base: http://localhost:{{port}}/v1\nAPI Key: {{key}}', copyHint: '适用于任何支持 OpenAI API 的客户端', created_at: nowTs(), updated_at: nowTs() },
      ]) as T;
    case 'create_gateway_template': {
      const gts = getStore<any[]>('gateway_templates', []);
      const gt = { id: genId(), ...(args as any), created_at: nowTs(), updated_at: nowTs() };
      gts.push(gt);
      setStore('gateway_templates', gts);
      return gt as T;
    }
    case 'delete_gateway_template': {
      const gts2 = getStore<any[]>('gateway_templates', []);
      setStore('gateway_templates', gts2.filter(g => g.id !== (args as any)?.id));
      return undefined as T;
    }
    case 'copy_gateway_template': {
      const cgtList = getStore<any[]>('gateway_templates', []);
      const cgtMatch = cgtList.find(t => t.id === (args as any)?.templateId);
      return (cgtMatch?.content ?? '# Gateway Template Configuration\n\nNo template found.') as T;
    }
    case 'apply_gateway_template':
      return { success: true, applied_at: nowTs() } as T;

    // ── Phase 2: Desktop Integration ──────────────────────────────────
    case 'get_desktop_capabilities':
      return [
        { key: 'tray', supported: false },
        { key: 'global_shortcut', supported: true },
        { key: 'protocol_handler', supported: false },
        { key: 'mini_window', supported: false },
        { key: 'notification', supported: 'Notification' in globalThis },
      ] as T;
    case 'get_window_state':
      return { width: globalThis.innerWidth ?? 1280, height: globalThis.innerHeight ?? 800, focused: true, fullscreen: false } as T;
    case 'send_desktop_notification': {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification((args as any)?.title ?? 'AQBot', { body: (args as any)?.body ?? '' });
      }
      return undefined as T;
    }
    case 'set_always_on_top':
      console.log('[Mock] set_always_on_top:', (args as any)?.enabled);
      return undefined as T;
    case 'set_close_to_tray':
      console.log('[Mock] set_close_to_tray:', (args as any)?.enabled);
      return undefined as T;
    case 'apply_startup_settings':
      console.log('[Mock] apply_startup_settings:', args);
      return undefined as T;
    case 'set_tray_actions':
      return undefined as T;
    case 'handle_protocol_launch':
      return undefined as T;

    // ── Phase 2: Workspace Snapshot ────────────────────────────────────
    case 'get_workspace_snapshot':
      return { conversations: [], providers: [], settings: {}, captured_at: nowTs() } as T;
    case 'update_workspace_snapshot':
      return undefined as T;

    // ── Proxy Test ────────────────────────────────────────────────────────
    case 'test_proxy': {
      const addr = (args as any)?.proxyAddress;
      if (!addr) return { ok: false, error: 'No address' } as T;
      await new Promise(r => setTimeout(r, 500));
      return { ok: true, latency_ms: 120 + Math.floor(Math.random() * 200) } as T;
    }

    default:
      console.warn(`[BrowserMock] Unhandled command: ${cmd}`, args);
      return undefined as T;
  }
}
