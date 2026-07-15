import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationItemType } from '@ant-design/x/es/conversations/interface'
import type { ConversationListRow } from '../conversationListModel'
import { ConversationList } from '../ConversationList'

const virtualizerOptions = vi.hoisted(() => ({ current: null as any }))
const scrollToIndex = vi.hoisted(() => vi.fn())
const xProviderDirection = vi.hoisted(() => ({ current: 'ltr' as 'ltr' | 'rtl' }))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: any) => {
    virtualizerOptions.current = options
    const count = Math.min(options.count, 3)
    return {
      getTotalSize: () => options.count * 44,
      getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
        index,
        key: options.getItemKey(index),
        start: index * 44,
        size: 44,
      })),
      scrollToIndex,
    }
  },
}))

vi.mock('@ant-design/x/es/conversations', async () => {
  const { useState } = await import('react')

  const NativeRow = ({ item, menu, onActiveChange }: any) => {
    const [menuOpen, setMenuOpen] = useState(false)
    const menuConfig = typeof menu === 'function' ? menu(item) : menu
    const originNode = (
      <button type="button" aria-label={`native-row-menu-${item.key}`}>
        menu
      </button>
    )
    const menuTrigger = typeof menuConfig?.trigger === 'function'
      ? menuConfig.trigger(item, { originNode })
      : menuConfig?.trigger ?? originNode
    const tryOpen = () => {
      if ((menuConfig?.items?.length ?? 0) > 0) setMenuOpen(true)
    }

    return (
      <li
        data-conv-id={item['data-conv-id']}
        onClick={() => onActiveChange?.(item.key, item)}
      >
        {item.label}
        {menuConfig && <span onClick={tryOpen}>{menuTrigger}</span>}
        {menuOpen && menuConfig.items.map((menuItem: any) => (
          <button
            key={menuItem.key}
            type="button"
            aria-label={`menu-action-${menuItem.key}`}
          >
            {menuItem.label}
          </button>
        ))}
      </li>
    )
  }

  return {
    default: ({ items, onActiveChange, menu, activeKey: _activeKey, groupable: _groupable, ...props }: any) => (
      <ul data-testid="native-conversations" {...props}>
        {items.map((item: any) => (
          <NativeRow
            key={item.key}
            item={item}
            menu={menu}
            onActiveChange={onActiveChange}
          />
        ))}
      </ul>
    ),
  }
})

vi.mock('@ant-design/x/es/conversations/style', () => ({
  default: () => ['ant-conversations-hash', 'ant-conversations-css-vars'],
}))

vi.mock('@ant-design/x/es/x-provider', () => ({
  useXProviderContext: () => ({
    getPrefixCls: (suffix: string) => `ant-${suffix}`,
    direction: xProviderDirection.current,
  }),
}))

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>()
  const { useState } = await import('react')

  const MockDropdown = ({ children, menu, onOpenChange, placement }: any) => {
    const [open, setOpen] = useState(false)
    const tryOpen = () => {
      if ((menu?.items?.length ?? 0) === 0) return
      setOpen(true)
      onOpenChange?.(true)
    }

    return (
      <span data-placement={placement} onClick={tryOpen}>
        <button type="button" aria-label="open-row-menu" />
        {children}
        {open && menu.items.map((item: any) => (
          <button
            key={item.key}
            type="button"
            aria-label={`menu-action-${item.key}`}
            onClick={(event) => menu.onClick?.({ key: item.key, domEvent: event })}
          >
            {item.label}
          </button>
        ))}
      </span>
    )
  }

  return {
    ...actual,
    Dropdown: MockDropdown,
    Typography: { Text: ({ children, className }: any) => <span className={className}>{children}</span> },
    theme: {
      useToken: () => ({ token: {
        controlHeightLG: 40,
        paddingXXS: 4,
        paddingSM: 12,
        paddingXL: 24,
      } }),
    },
  }
})

function rows(count: number): ConversationListRow[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'conversation' as const,
    key: `conversation:conv-${index}`,
    group: 'today',
    isChild: false,
    childCount: 0,
    expanded: false,
    conversation: {
      id: `conv-${index}`,
      title: `Conversation ${index}`,
    } as ConversationListRow extends { conversation: infer T } ? T : never,
  }))
}

const toItem = (row: Exclude<ConversationListRow, { type: 'groupHeader' }>): ConversationItemType => {
  if (row.type === 'emptyCategory') {
    return { key: row.key, group: row.group, label: 'empty', disabled: true }
  }
  return {
    key: row.conversation.id,
    group: row.group,
    label: row.conversation.title,
    'data-conv-id': row.conversation.id,
  }
}

function renderList(
  listRows: ConversationListRow[],
  overrides: Partial<React.ComponentProps<typeof ConversationList>> = {},
) {
  const scrollElementRef = { current: document.createElement('div') }
  return render(
    <ConversationList
      rows={listRows}
      activeKey="conv-0"
      onActiveChange={vi.fn()}
      getItem={toItem}
      menu={() => ({ items: [] })}
      renderGroupLabel={(group) => group}
      onGroupToggle={vi.fn()}
      nativeGroupable={{}}
      scrollElementRef={scrollElementRef}
      {...overrides}
    />,
  )
}

describe('ConversationList threshold behavior', () => {
  beforeEach(() => {
    scrollToIndex.mockClear()
    virtualizerOptions.current = null
    xProviderDirection.current = 'ltr'
  })

  it('keeps 159 flattened rows on native Ant Conversations', () => {
    renderList(rows(159))

    expect(screen.getByTestId('native-conversations')).toHaveAttribute('data-list-mode', 'native')
    expect(virtualizerOptions.current).toBeNull()
  })

  it('opens a deferred native row menu on the first user click', async () => {
    const user = userEvent.setup()
    const menu = vi.fn((_item, options) => ({
      items: options?.includeItems ? [{ key: 'delete', label: 'delete' }] : [],
    }))
    renderList(rows(159), { menu })

    expect(menu).not.toHaveBeenCalled()

    await user.hover(screen.getByText('Conversation 0').closest('li')!)
    expect(menu.mock.calls.some(([, options]) => options?.includeItems === false)).toBe(true)
    expect(menu.mock.calls.some(([, options]) => options?.includeItems === true)).toBe(false)

    await user.click(screen.getByRole('button', { name: 'native-row-menu-conv-0' }))
    expect(menu.mock.calls.some(([, options]) => options?.includeItems === true)).toBe(true)
    expect(screen.getByRole('button', { name: 'menu-action-delete' })).toBeVisible()
  })

  it.each([160, 161])('virtualizes %s flattened rows with overscan 8', (count) => {
    renderList(rows(count))

    expect(screen.queryByTestId('native-conversations')).not.toBeInTheDocument()
    expect(screen.getByRole('list')).toHaveAttribute('data-list-mode', 'virtual')
    expect(virtualizerOptions.current).toMatchObject({ count, overscan: 8 })
    expect(screen.getByText('Conversation 0')).toBeInTheDocument()
    expect(screen.queryByText(`Conversation ${count - 1}`)).not.toBeInTheDocument()
  })

  it('keeps active state and click behavior in the virtual branch', () => {
    const onActiveChange = vi.fn()
    renderList(rows(160), { onActiveChange })

    const activeRow = screen.getByText('Conversation 0').closest('li')
    expect(activeRow).toHaveClass('ant-conversations-item-active')

    fireEvent.click(screen.getByText('Conversation 1'))
    expect(onActiveChange).toHaveBeenCalledWith('conv-1', expect.objectContaining({ key: 'conv-1' }))
  })

  it('keeps collapsible category behavior in the virtual branch', () => {
    const onGroupToggle = vi.fn()
    const listRows: ConversationListRow[] = [
      {
        type: 'groupHeader',
        key: 'group:cat:work',
        group: 'cat:work',
        category: null,
        collapsible: true,
        expanded: false,
      },
      ...rows(159),
    ]
    renderList(listRows, { onGroupToggle })

    fireEvent.click(screen.getByText('cat:work'))
    expect(onGroupToggle).toHaveBeenCalledWith('cat:work')
  })

  it('only constructs visible items and opens a deferred virtual menu on the first click', async () => {
    const user = userEvent.setup()
    const getItem = vi.fn(toItem)
    const menu = vi.fn((_item, options) => ({
      items: options?.includeItems ? [{ key: 'delete', label: 'delete' }] : [],
    }))
    renderList(rows(160), { getItem, menu })

    expect(getItem).toHaveBeenCalledTimes(3)
    expect(menu).not.toHaveBeenCalled()

    await user.hover(screen.getByText('Conversation 0').closest('li')!)
    expect(menu.mock.calls.some(([, options]) => options?.includeItems === false)).toBe(true)
    await user.click(screen.getAllByRole('button', { name: 'open-row-menu' })[0])
    expect(menu.mock.calls.some(([, options]) => options?.includeItems === true)).toBe(true)
    expect(screen.getByRole('button', { name: 'menu-action-delete' })).toBeVisible()
  })

  it('executes the requested virtual-row menu command', async () => {
    const user = userEvent.setup()
    const onMenuClick = vi.fn()
    const menu = vi.fn((_item, options) => ({
      items: options?.includeItems ? [{ key: 'archive', label: 'archive' }] : [],
      onClick: onMenuClick,
    }))
    renderList(rows(160), { menu })

    await user.hover(screen.getByText('Conversation 0').closest('li')!)
    await user.click(screen.getAllByRole('button', { name: 'open-row-menu' })[0])
    await user.click(screen.getByRole('button', { name: 'menu-action-archive' }))

    expect(onMenuClick).toHaveBeenCalledWith(expect.objectContaining({ key: 'archive' }))
  })

  it('preserves context-menu and keyboard handlers on virtual rows', () => {
    const onContextMenu = vi.fn()
    const onDeleteShortcut = vi.fn()
    const getItem = (row: Exclude<ConversationListRow, { type: 'groupHeader' }>) => ({
      ...toItem(row),
      tabIndex: 0,
      onContextMenu,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === 'Delete') onDeleteShortcut()
      },
    })
    renderList(rows(160), { getItem })

    const firstRow = screen.getByText('Conversation 0').closest('li')!
    fireEvent.contextMenu(firstRow)
    fireEvent.keyDown(firstRow, { key: 'Delete' })

    expect(onContextMenu).toHaveBeenCalledTimes(1)
    expect(onDeleteShortcut).toHaveBeenCalledTimes(1)
  })

  it('preserves multi-select controls without activating the conversation row', () => {
    const onSelect = vi.fn()
    const onActiveChange = vi.fn()
    renderList(rows(160), {
      onActiveChange,
      getItem: (row) => ({
        ...toItem(row),
        icon: (
          <button
            type="button"
            aria-label={`select-${row.key}`}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(row.key)
            }}
          />
        ),
      }),
    })

    fireEvent.click(screen.getByRole('button', { name: 'select-conversation:conv-0' }))

    expect(onSelect).toHaveBeenCalledWith('conversation:conv-0')
    expect(onActiveChange).not.toHaveBeenCalled()
  })

  it('keeps fixed row height, child indentation, and interactive group labels', () => {
    const onGroupPointerDown = vi.fn()
    const childRows = rows(159)
    const firstChild = childRows[0]
    if (firstChild.type !== 'conversation') throw new Error('expected conversation row')
    childRows[0] = { ...firstChild, group: 'cat:work', isChild: true }
    const listRows: ConversationListRow[] = [
      {
        type: 'groupHeader',
        key: 'group:cat:work',
        group: 'cat:work',
        category: null,
        collapsible: true,
        expanded: true,
      },
      ...childRows,
    ]
    renderList(listRows, {
      getItem: (row) => ({
        ...toItem(row),
        ...(row.type === 'conversation' && row.isChild
          ? { style: { paddingInlineStart: 20 } }
          : {}),
      }),
      renderGroupLabel: () => (
        <button type="button" onPointerDown={onGroupPointerDown}>drag group</button>
      ),
    })

    fireEvent.pointerDown(screen.getByRole('button', { name: 'drag group' }))
    const childRow = screen.getByText('Conversation 0').closest('li')!

    expect(onGroupPointerDown).toHaveBeenCalledTimes(1)
    expect(childRow).toHaveStyle({ height: '40px', paddingInlineStart: '44px' })
  })

  it('uses logical positioning and RTL-native menu placement', () => {
    xProviderDirection.current = 'rtl'
    renderList(rows(160))

    const list = screen.getByRole('list')
    const firstRow = screen.getByText('Conversation 0').closest('li')!
    expect(list).toHaveClass('ant-conversations-rtl')
    expect(firstRow.style.insetInlineStart).toBe('12px')

    fireEvent.pointerEnter(firstRow)
    expect(screen.getAllByRole('button', { name: 'open-row-menu' })[0].parentElement)
      .toHaveAttribute('data-placement', 'bottomLeft')
  })
})
