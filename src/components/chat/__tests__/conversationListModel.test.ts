import { describe, expect, it } from 'vitest'
import type { Conversation, ConversationCategory } from '@/types'
import {
  buildConversationRows,
  filterConversationsWithParents,
  getSearchExpandedParentIds,
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
    is_pinned: false,
    is_archived: false,
    context_compression: false,
    category_id: null,
    parent_conversation_id: null,
    message_count: 0,
    created_at: 1,
    updated_at: 1_704_067_200,
    ...overrides,
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
