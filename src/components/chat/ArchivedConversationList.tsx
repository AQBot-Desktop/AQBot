import { useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Conversation } from '@/types'
import { NATIVE_LIST_MAX_ROWS, SIDEBAR_OVERSCAN } from './conversationListModel'

const ARCHIVED_ROW_HEIGHT = 40

interface ArchivedConversationListProps {
  conversations: readonly Conversation[]
  renderConversation: (conversation: Conversation) => ReactNode
}

function ArchivedVirtualList({
  conversations,
  renderConversation,
}: ArchivedConversationListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ARCHIVED_ROW_HEIGHT,
    overscan: SIDEBAR_OVERSCAN,
  })

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto" data-archived-list-mode="virtual">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', padding: '4px 0' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={conversations[row.index].id}
            style={{
              position: 'absolute',
              insetInlineStart: 0,
              top: 4,
              width: '100%',
              height: row.size,
              transform: `translateY(${row.start}px)`,
            }}
          >
            {renderConversation(conversations[row.index])}
          </div>
        ))}
      </div>
    </div>
  )
}

export function ArchivedConversationList(props: ArchivedConversationListProps) {
  if (props.conversations.length > NATIVE_LIST_MAX_ROWS) {
    return <ArchivedVirtualList {...props} />
  }

  return (
    <div className="flex-1 overflow-y-auto" data-archived-list-mode="native">
      <div style={{ padding: '4px 0' }}>
        {props.conversations.map((conversation) => (
          <div key={conversation.id}>{props.renderConversation(conversation)}</div>
        ))}
      </div>
    </div>
  )
}
