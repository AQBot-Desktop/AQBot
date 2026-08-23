import { describe, expect, it } from 'vitest'
import type { Conversation, ConversationCategory } from '@/types'
import {
  buildConversationRows,
  filterConversationsWithParents,
  getSearchExpandedParentIds,
  planConversationReorder,
} from '../conversationListModel'

function conversation(
  id: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    title: id,
    model_id: 'model-1',
    provider_id: 'provider-1',
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
    multi_model_display_mode_override: null,
    is_pinned: false,
    is_archived: false,
    context_compression: false,
    context_strategy_override: null,
    context_message_limit: null,
    compression_keep_last_n: null,
    category_id: null,
    parent_conversation_id: null,
    message_count: 0,
    created_at: 1,
    updated_at: 1_704_067_200,
    ...overrides,
    sort_order: overrides.sort_order ?? 0,
  }
}

function category(
  id: string,
  overrides: Partial<ConversationCategory> = {},
): ConversationCategory {
  return {
    id,
    name: id,
    icon_type: null,
    icon_value: null,
    system_prompt: null,
    default_provider_id: null,
    default_model_id: null,
    default_temperature: null,
    default_max_tokens: null,
    default_top_p: null,
    default_frequency_penalty: null,
    sort_order: 0,
    is_collapsed: false,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

describe('buildConversationRows', () => {
  it('builds category, parent-child, empty and date groups in one stable row model', () => {
    const rows = buildConversationRows({
      conversations: [
        conversation('parent', { category_id: 'work', updated_at: 10 }),
        conversation('child', { parent_conversation_id: 'parent', updated_at: 9 }),
        conversation('pinned', { is_pinned: true, updated_at: 8 }),
        conversation('today', { updated_at: 1_704_153_600 }),
      ],
      categories: [category('work'), category('empty')],
      expandedParentIds: new Set(['parent']),
      expandedGroupKeys: new Set(['cat:work', 'cat:empty']),
      nowSeconds: 1_704_153_600,
    })

    expect(rows.map((row) => {
      if (row.type === 'conversation') {
        return `${row.type}:${row.conversation.id}:${row.isChild ? 'child' : 'root'}`
      }
      return `${row.type}:${row.group}`
    })).toEqual([
      'groupHeader:cat:work',
      'conversation:parent:root',
      'conversation:child:child',
      'groupHeader:cat:empty',
      'emptyCategory:cat:empty',
      'groupHeader:pinned',
      'conversation:pinned:root',
      'groupHeader:today',
      'conversation:today:root',
    ])
  })

  it('keeps collapsed category headers while omitting their content', () => {
    const rows = buildConversationRows({
      conversations: [conversation('work-1', { category_id: 'work' })],
      categories: [category('work')],
      expandedParentIds: new Set(),
      expandedGroupKeys: new Set(),
      nowSeconds: 1_704_153_600,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'groupHeader',
      group: 'cat:work',
      collapsible: true,
      expanded: false,
    })
  })

  it('only includes child rows after their parent is expanded', () => {
    const input = {
      conversations: [
        conversation('parent'),
        conversation('child', { parent_conversation_id: 'parent' }),
      ],
      categories: [],
      expandedGroupKeys: new Set<string>(),
      nowSeconds: 1_704_153_600,
    }

    const collapsed = buildConversationRows({
      ...input,
      expandedParentIds: new Set(),
    })
    const expanded = buildConversationRows({
      ...input,
      expandedParentIds: new Set(['parent']),
    })

    expect(collapsed.filter((row) => row.type === 'conversation').map((row) => row.conversation.id))
      .toEqual(['parent'])
    expect(expanded.filter((row) => row.type === 'conversation').map((row) => row.conversation.id))
      .toEqual(['parent', 'child'])
  })

  it('uses fixed uncategorized groups and manual order within each group', () => {
    const rows = buildConversationRows({
      conversations: [
        conversation('today-later-rank', { sort_order: 2, updated_at: 1_704_153_600 }),
        conversation('earlier', { sort_order: 0, updated_at: 1_700_000_000 }),
        conversation('pinned', { is_pinned: true, sort_order: 4, updated_at: 1 }),
        conversation('today-first-rank', { sort_order: 1, updated_at: 1_704_153_500 }),
      ],
      categories: [],
      expandedParentIds: new Set(),
      expandedGroupKeys: new Set(),
      nowSeconds: 1_704_153_600,
    })

    expect(rows.map((row) => (
      row.type === 'conversation' ? row.conversation.id : row.group
    ))).toEqual([
      'pinned',
      'pinned',
      'today',
      'today-first-rank',
      'today-later-rank',
      'earlier',
      'earlier',
    ])
  })

  it('uses updated time and id as deterministic rank tie breakers', () => {
    const categorizedRows = buildConversationRows({
      conversations: [
        conversation('b', { category_id: 'work', sort_order: 0, updated_at: 20 }),
        conversation('c', { category_id: 'work', sort_order: 0, updated_at: 30 }),
        conversation('a', { category_id: 'work', sort_order: 0, updated_at: 20 }),
      ],
      categories: [category('work')],
      expandedParentIds: new Set(),
      expandedGroupKeys: new Set(['cat:work']),
      nowSeconds: 1_704_153_600,
    })
    expect(categorizedRows
      .filter((row) => row.type === 'conversation')
      .map((row) => row.conversation.id))
      .toEqual(['c', 'a', 'b'])
  })
})

describe('planConversationReorder', () => {
  it('moves a top-level category conversation and excludes its child from the payload', () => {
    const rows = buildConversationRows({
      conversations: [
        conversation('parent-a', { category_id: 'work', sort_order: 0 }),
        conversation('child-a', {
          category_id: 'work',
          parent_conversation_id: 'parent-a',
          sort_order: 0,
        }),
        conversation('parent-b', { category_id: 'work', sort_order: 1 }),
      ],
      categories: [category('work')],
      expandedParentIds: new Set(['parent-a']),
      expandedGroupKeys: new Set(['cat:work']),
    })

    expect(planConversationReorder(rows, 'parent-a', 'parent-b')).toEqual({
      categoryId: 'work',
      conversationIds: ['parent-b', 'parent-a'],
    })
    expect(planConversationReorder(rows, 'child-a', 'parent-b')).toBeNull()
    expect(planConversationReorder(rows, 'parent-b', 'child-a')).toBeNull()
  })

  it('keeps the complete uncategorized payload while only moving inside one date group', () => {
    const rows = buildConversationRows({
      conversations: [
        conversation('pinned', { is_pinned: true, sort_order: 0 }),
        conversation('today-a', { sort_order: 1, updated_at: 1_704_153_600 }),
        conversation('today-b', { sort_order: 2, updated_at: 1_704_153_500 }),
        conversation('earlier', { sort_order: 3, updated_at: 1_700_000_000 }),
      ],
      categories: [],
      expandedParentIds: new Set(),
      expandedGroupKeys: new Set(),
      nowSeconds: 1_704_153_600,
    })

    expect(planConversationReorder(rows, 'today-a', 'today-b')).toEqual({
      categoryId: null,
      conversationIds: ['pinned', 'today-b', 'today-a', 'earlier'],
    })
    expect(planConversationReorder(rows, 'today-a', 'pinned')).toBeNull()
    expect(planConversationReorder(rows, 'today-a', 'earlier')).toBeNull()
  })

  it('rejects moves across categories', () => {
    const rows = buildConversationRows({
      conversations: [
        conversation('work-a', { category_id: 'work' }),
        conversation('home-a', { category_id: 'home' }),
      ],
      categories: [category('work'), category('home')],
      expandedParentIds: new Set(),
      expandedGroupKeys: new Set(['cat:work', 'cat:home']),
    })

    expect(planConversationReorder(rows, 'work-a', 'home-a')).toBeNull()
  })
})

describe('filterConversationsWithParents', () => {
  it('keeps a matching child and its parent so the child remains reachable in the row model', () => {
    const parent = conversation('parent', { title: 'Parent title' })
    const matchingChild = conversation('child', {
      title: 'Needle result',
      parent_conversation_id: parent.id,
    })
    const unrelated = conversation('unrelated', { title: 'Something else' })

    expect(filterConversationsWithParents(
      [parent, matchingChild, unrelated],
      'needle',
    ).map((item) => item.id)).toEqual(['parent', 'child'])
  })

  it('returns the original collection for an empty query', () => {
    const conversations = [conversation('first'), conversation('second')]
    expect(filterConversationsWithParents(conversations, '  ')).toBe(conversations)
  })

  it('marks every matching child ancestor for temporary search expansion', () => {
    const conversations = [
      conversation('root', { title: 'Root' }),
      conversation('child', { title: 'Needle child', parent_conversation_id: 'root' }),
    ]

    expect([...getSearchExpandedParentIds(conversations, 'needle')]).toEqual(['root'])
    expect([...getSearchExpandedParentIds(conversations, 'root')]).toEqual([])
  })
})
