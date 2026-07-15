import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchivedConversationList } from '../ArchivedConversationList'
import type { Conversation } from '@/types'

const virtualizerOptions = { current: null as null | { count: number; overscan: number } }

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; overscan: number }) => {
    virtualizerOptions.current = options
    return {
      getTotalSize: () => options.count * 40,
      getVirtualItems: () => [0, 1, 2].map((index) => ({
        index,
        key: index,
        start: index * 40,
        size: 40,
      })),
    }
  },
}))

function conversations(count: number): Conversation[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `conv-${index}`,
    title: `Archived ${index}`,
  } as Conversation))
}

describe('ArchivedConversationList', () => {
  beforeEach(() => {
    virtualizerOptions.current = null
  })

  it('keeps 159 rows native', () => {
    render(
      <ArchivedConversationList
        conversations={conversations(159)}
        renderConversation={(conversation) => conversation.title}
      />,
    )

    expect(screen.getByText('Archived 158')).toBeInTheDocument()
    expect(screen.getByText('Archived 0').closest('[data-archived-list-mode]'))
      .toHaveAttribute('data-archived-list-mode', 'native')
    expect(virtualizerOptions.current).toBeNull()
  })

  it('virtualizes from 160 rows with overscan 8', () => {
    render(
      <ArchivedConversationList
        conversations={conversations(160)}
        renderConversation={(conversation) => conversation.title}
      />,
    )

    expect(screen.getByText('Archived 0').closest('[data-archived-list-mode]'))
      .toHaveAttribute('data-archived-list-mode', 'virtual')
    expect(screen.queryByText('Archived 159')).not.toBeInTheDocument()
    expect(virtualizerOptions.current).toMatchObject({ count: 160, overscan: 8 })
  })
})
