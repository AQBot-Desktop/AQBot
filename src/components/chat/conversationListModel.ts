import type { Conversation, ConversationCategory } from '@/types'

export const NATIVE_LIST_MAX_ROWS = 159
export const VIRTUAL_LIST_MIN_ROWS = 160
export const SIDEBAR_OVERSCAN = 8

export type ConversationListRow =
  | {
    type: 'groupHeader'
    key: string
    group: string
    category: ConversationCategory | null
    collapsible: boolean
    expanded: boolean
  }
  | {
    type: 'conversation'
    key: string
    group: string
    conversation: Conversation
    isChild: boolean
    childCount: number
    expanded: boolean
  }
  | {
    type: 'emptyCategory'
    key: string
    group: string
    category: ConversationCategory
  }

interface BuildConversationRowsInput {
  conversations: readonly Conversation[]
  categories: readonly ConversationCategory[]
  expandedParentIds: ReadonlySet<string>
  expandedGroupKeys: ReadonlySet<string>
  nowSeconds?: number
}

export function filterConversationsWithParents(
  conversations: readonly Conversation[],
  rawQuery: string,
): readonly Conversation[] {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (!query) return conversations

  const conversationById = new Map(conversations.map((item) => [item.id, item]))
  const includedIds = new Set<string>()
  for (const conversation of conversations) {
    if (!conversation.title.toLocaleLowerCase().includes(query)) continue
    includedIds.add(conversation.id)

    let parentId = conversation.parent_conversation_id
    while (parentId && !includedIds.has(parentId)) {
      includedIds.add(parentId)
      parentId = conversationById.get(parentId)?.parent_conversation_id ?? null
    }
  }

  return conversations.filter((conversation) => includedIds.has(conversation.id))
}

export function getSearchExpandedParentIds(
  conversations: readonly Conversation[],
  rawQuery: string,
): ReadonlySet<string> {
  const query = rawQuery.trim().toLocaleLowerCase()
  const expandedParentIds = new Set<string>()
  if (!query) return expandedParentIds

  const conversationById = new Map(conversations.map((item) => [item.id, item]))
  for (const conversation of conversations) {
    if (!conversation.title.toLocaleLowerCase().includes(query)) continue

    let parentId = conversation.parent_conversation_id
    while (parentId && !expandedParentIds.has(parentId)) {
      expandedParentIds.add(parentId)
      parentId = conversationById.get(parentId)?.parent_conversation_id ?? null
    }
  }

  return expandedParentIds
}

function getDateGroup(timestamp: number, nowSeconds: number): string {
  const now = new Date(nowSeconds * 1000)
  const date = new Date(timestamp * 1000)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000)
  const startOfWeek = new Date(startOfToday.getTime() - startOfToday.getDay() * 86_400_000)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  if (date >= startOfToday) return 'today'
  if (date >= startOfYesterday) return 'yesterday'
  if (date >= startOfWeek) return 'thisWeek'
  if (date >= startOfMonth) return 'thisMonth'
  return 'earlier'
}

export function buildConversationRows({
  conversations,
  categories,
  expandedParentIds,
  expandedGroupKeys,
  nowSeconds = Date.now() / 1000,
}: BuildConversationRowsInput): ConversationListRow[] {
  const childrenByParent = new Map<string, Conversation[]>()
  const topLevel: Conversation[] = []

  for (const conversation of conversations) {
    if (conversation.parent_conversation_id) {
      const children = childrenByParent.get(conversation.parent_conversation_id)
      if (children) children.push(conversation)
      else childrenByParent.set(conversation.parent_conversation_id, [conversation])
    } else {
      topLevel.push(conversation)
    }
  }

  const conversationsByCategory = new Map<string, Conversation[]>()
  const uncategorized: Conversation[] = []
  for (const conversation of topLevel) {
    if (conversation.category_id) {
      const grouped = conversationsByCategory.get(conversation.category_id)
      if (grouped) grouped.push(conversation)
      else conversationsByCategory.set(conversation.category_id, [conversation])
    } else {
      uncategorized.push(conversation)
    }
  }

  const rows: ConversationListRow[] = []
  const pushConversation = (conversation: Conversation, group: string, isChild = false) => {
    const children = childrenByParent.get(conversation.id) ?? []
    rows.push({
      type: 'conversation',
      key: `conversation:${conversation.id}`,
      group,
      conversation,
      isChild,
      childCount: children.length,
      expanded: expandedParentIds.has(conversation.id),
    })
    if (!expandedParentIds.has(conversation.id)) return
    for (const child of children) {
      rows.push({
        type: 'conversation',
        key: `conversation:${child.id}`,
        group,
        conversation: child,
        isChild: true,
        childCount: 0,
        expanded: false,
      })
    }
  }

  for (const category of categories) {
    const group = `cat:${category.id}`
    const expanded = expandedGroupKeys.has(group)
    rows.push({
      type: 'groupHeader',
      key: `group:${group}`,
      group,
      category,
      collapsible: true,
      expanded,
    })
    if (!expanded) continue

    const grouped = conversationsByCategory.get(category.id)
    if (grouped?.length) {
      for (const conversation of grouped) pushConversation(conversation, group)
    } else {
      rows.push({
        type: 'emptyCategory',
        key: `empty:${category.id}`,
        group,
        category,
      })
    }
  }

  const uncategorizedGroups = new Map<string, Conversation[]>()
  for (const conversation of uncategorized) {
    const group = conversation.is_pinned
      ? 'pinned'
      : getDateGroup(conversation.updated_at, nowSeconds)
    const grouped = uncategorizedGroups.get(group)
    if (grouped) grouped.push(conversation)
    else uncategorizedGroups.set(group, [conversation])
  }

  for (const [group, grouped] of uncategorizedGroups) {
    rows.push({
      type: 'groupHeader',
      key: `group:${group}`,
      group,
      category: null,
      collapsible: false,
      expanded: true,
    })
    for (const conversation of grouped) pushConversation(conversation, group)
  }

  return rows
}
