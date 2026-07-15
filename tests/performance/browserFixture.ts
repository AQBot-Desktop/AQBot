import type { Page } from '@playwright/test';

export const CONVERSATION_SCALES = [77, 159, 160, 161, 500, 1000] as const;

interface BrowserFixtureOptions {
  conversationCount: number;
  messagesInActiveConversation?: number;
  messagesInConversationCount?: number;
  drawingGenerationCount?: number;
  chatAttachment?: boolean;
  drawingImagesPerGeneration?: number;
  childConversationIndex?: number;
  settingsLanguage?: string;
  categoryCount?: number;
}

interface BrowserFixture {
  stores: Record<string, unknown>;
  activeConversationId: string;
  expandedRowCount: number;
}

const FIXED_NOW_SECONDS = 1_893_456_000;
const PROVIDER_ID = 'perf-openai';
const CHAT_MODEL_ID = 'perf-chat';
const PROFILE_IMAGE = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32"%3E%3Crect width="32" height="32" rx="16" fill="%2317a93d"/%3E%3Cpath d="M10 22V10h7a4 4 0 0 1 0 8h-4v4z" fill="white"/%3E%3C/svg%3E';
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function padded(index: number): string {
  return String(index).padStart(4, '0');
}

function buildConversations(
  count: number,
  messageCount: number,
  messageConversationCount: number,
  childConversationIndex?: number,
  categoryCount = 0,
) {
  const conversations = Array.from({ length: count }, (_, index) => ({
    id: `perf-conversation-${padded(index)}`,
    title: `Performance conversation ${padded(index)}`,
    model_id: CHAT_MODEL_ID,
    provider_id: PROVIDER_ID,
    system_prompt: null,
    temperature: null,
    max_tokens: null,
    top_p: null,
    frequency_penalty: null,
    search_enabled: false,
    search_provider_id: null,
    thinking_budget: null,
    thinking_level: null,
    enabled_mcp_server_ids: [],
    enabled_knowledge_base_ids: [],
    enabled_memory_namespace_ids: [],
    is_pinned: false,
    is_archived: false,
    context_compression: false,
    category_id: null,
    parent_conversation_id: null,
    mode: 'chat',
    message_count: index < messageConversationCount ? messageCount : 0,
    created_at: FIXED_NOW_SECONDS - index,
    updated_at: FIXED_NOW_SECONDS - index,
  }));
  if (childConversationIndex !== undefined) {
    if (childConversationIndex < 1 || childConversationIndex >= conversations.length) {
      throw new Error(`childConversationIndex must be between 1 and ${conversations.length - 1}`);
    }
    conversations[childConversationIndex].parent_conversation_id = conversations[0].id;
  }
  for (let index = 0; index < Math.min(categoryCount, conversations.length); index += 1) {
    conversations[index].category_id = `perf-category-${index}`;
  }
  return conversations;
}

function buildCategories(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `perf-category-${index}`,
    name: `Performance category ${index}`,
    icon_type: null,
    icon_value: null,
    system_prompt: null,
    default_provider_id: null,
    default_model_id: null,
    default_temperature: null,
    default_max_tokens: null,
    default_top_p: null,
    default_frequency_penalty: null,
    sort_order: index,
    is_collapsed: false,
    created_at: FIXED_NOW_SECONDS,
    updated_at: FIXED_NOW_SECONDS,
  }));
}

function buildMessages(conversationId: string, count: number, withAttachment: boolean) {
  const conversationKey = conversationId.replace(/^perf-conversation-/, '');
  return Array.from({ length: count }, (_, index) => {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    return {
      id: `perf-message-${conversationKey}-${padded(index)}`,
      conversation_id: conversationId,
      role,
      content: role === 'assistant'
        ? `Assistant response ${padded(index)}\n\n- deterministic fixture\n- production rendering`
        : `User message ${padded(index)}`,
      provider_id: role === 'assistant' ? PROVIDER_ID : null,
      model_id: role === 'assistant' ? CHAT_MODEL_ID : null,
      token_count: 16,
      prompt_tokens: role === 'assistant' ? 8 : null,
      completion_tokens: role === 'assistant' ? 8 : null,
      attachments: withAttachment && index === Math.max(0, count - 2) ? [{
        id: 'perf-chat-attachment',
        file_name: 'fixture.png',
        file_type: 'image/png',
        file_size: 68,
        file_path: 'images/fixture.png',
        data: null,
      }] : [],
      thinking: null,
      tool_calls_json: null,
      tool_call_id: null,
      created_at: FIXED_NOW_SECONDS + index,
      parent_message_id: role === 'assistant'
        ? `perf-message-${conversationKey}-${padded(index - 1)}`
        : null,
      version_index: 0,
      is_active: true,
      status: 'complete',
      tokens_per_second: null,
      first_token_latency_ms: null,
    };
  });
}

function buildProvider() {
  return {
    id: PROVIDER_ID,
    name: 'Performance OpenAI',
    provider_type: 'openai',
    api_host: 'https://example.invalid',
    api_path: null,
    enabled: true,
    models: [
      {
        provider_id: PROVIDER_ID,
        model_id: CHAT_MODEL_ID,
        name: 'Performance Chat',
        model_type: 'Chat',
        capabilities: ['TextChat'],
        max_tokens: 128_000,
        enabled: true,
        param_overrides: null,
      },
      {
        provider_id: PROVIDER_ID,
        model_id: 'gpt-image-2',
        name: 'GPT Image 2',
        model_type: 'Image',
        capabilities: [],
        max_tokens: null,
        enabled: true,
        param_overrides: null,
      },
    ],
    keys: [],
    proxy_config: null,
    sort_order: 0,
    created_at: FIXED_NOW_SECONDS,
    updated_at: FIXED_NOW_SECONDS,
  };
}

function buildDrawingHistory(count: number, imagesPerGeneration: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `perf-drawing-${index}`,
    parent_generation_id: null,
    provider_id: PROVIDER_ID,
    key_id: 'perf-key',
    model_id: 'gpt-image-2',
    api_kind: 'image_api',
    action: 'generate',
    prompt: `Deterministic drawing ${index}`,
    parameters_json: '{}',
    reference_file_ids_json: '[]',
    source_image_ids_json: '[]',
    mask_file_id: null,
    status: 'succeeded',
    error_message: null,
    response_id: null,
    usage_json: null,
    created_at: FIXED_NOW_SECONDS + index,
    completed_at: FIXED_NOW_SECONDS + index,
    images: Array.from({ length: imagesPerGeneration }, (_, imageIndex) => ({
      id: `perf-drawing-image-${index}-${imageIndex}`,
      generation_id: `perf-drawing-${index}`,
      stored_file_id: `perf-drawing-file-${index}-${imageIndex}`,
      storage_path: `images/perf-drawing-${index}-${imageIndex}.png`,
      mime_type: 'image/png',
      width: 1,
      height: 1,
      revised_prompt: null,
      created_at: FIXED_NOW_SECONDS + index,
    })),
    reference_files: [],
    source_images: [],
    mask_file: null,
  }));
}

export function buildBrowserFixture({
  conversationCount,
  messagesInActiveConversation = 0,
  messagesInConversationCount = 1,
  drawingGenerationCount = 2,
  chatAttachment = false,
  drawingImagesPerGeneration = 0,
  childConversationIndex,
  settingsLanguage,
  categoryCount = 0,
}: BrowserFixtureOptions): BrowserFixture {
  if (!Number.isInteger(conversationCount) || conversationCount < 1) {
    throw new Error(`conversationCount must be a positive integer, got ${conversationCount}`);
  }
  if (
    !Number.isInteger(messagesInConversationCount)
    || messagesInConversationCount < 1
    || messagesInConversationCount > conversationCount
  ) {
    throw new Error(
      `messagesInConversationCount must be between 1 and ${conversationCount}, got ${messagesInConversationCount}`,
    );
  }

  const conversations = buildConversations(
    conversationCount,
    messagesInActiveConversation,
    messagesInConversationCount,
    childConversationIndex,
    categoryCount,
  );
  const activeConversationId = conversations[0].id;

  return {
    activeConversationId,
    expandedRowCount: conversationCount
      + categoryCount
      + (conversationCount > categoryCount ? 1 : 0)
      - (childConversationIndex === undefined ? 0 : 1),
    stores: {
      conversations,
      messages: conversations
        .slice(0, messagesInConversationCount)
        .flatMap((conversation) => buildMessages(
          conversation.id,
          messagesInActiveConversation,
          chatAttachment,
        )),
      conversation_categories: buildCategories(categoryCount),
      providers: [buildProvider()],
      drawing_generations: buildDrawingHistory(drawingGenerationCount, drawingImagesPerGeneration),
      drawing_files: Array.from(
        { length: drawingGenerationCount * drawingImagesPerGeneration },
        (_, flatIndex) => {
          const generationIndex = Math.floor(flatIndex / drawingImagesPerGeneration);
          const imageIndex = flatIndex % drawingImagesPerGeneration;
          return {
            id: `perf-drawing-file-${generationIndex}-${imageIndex}`,
            original_name: `perf-drawing-${generationIndex}-${imageIndex}.png`,
            mime_type: 'image/png',
            size_bytes: 68,
            storage_path: `images/perf-drawing-${generationIndex}-${imageIndex}.png`,
            data: ONE_PIXEL_PNG,
          };
        },
      ),
      user_profile: {
        state: {
          profile: {
            name: 'Performance User',
            avatarType: 'url',
            avatarValue: PROFILE_IMAGE,
          },
        },
        version: 0,
      },
      roles: [
        {
          id: 'perf-role',
          name: 'Performance Role',
          description: 'Deterministic role fixture',
          system_prompt: 'You are a deterministic performance fixture.',
          opening_message: null,
          opening_questions: [],
          tags: ['performance'],
          avatar: 'P',
          avatar_type: 'emoji',
          avatar_value: 'P',
          temperature: null,
          top_p: null,
          source_kind: 'local',
          source_ref: null,
          created_at: FIXED_NOW_SECONDS,
          updated_at: FIXED_NOW_SECONDS,
        },
      ],
      ...(settingsLanguage ? { settings: { language: settingsLanguage } } : {}),
    },
  };
}

export async function installBrowserFixture(
  page: Page,
  options: BrowserFixtureOptions,
): Promise<BrowserFixture> {
  const fixture = buildBrowserFixture(options);
  await page.addInitScript((stores: Record<string, unknown>) => {
    localStorage.clear();
    for (const [name, value] of Object.entries(stores)) {
      localStorage.setItem(`aqbot_${name}`, JSON.stringify(value));
    }
  }, fixture.stores);
  return fixture;
}
