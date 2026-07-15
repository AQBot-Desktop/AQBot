import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEventHandler,
  type RefObject,
} from 'react'
import { EllipsisOutlined, RightOutlined } from '@ant-design/icons'
import Conversations from '@ant-design/x/es/conversations'
import type { ConversationItemType, GroupableProps } from '@ant-design/x/es/conversations/interface'
import useConversationsStyle from '@ant-design/x/es/conversations/style'
import { useXProviderContext } from '@ant-design/x/es/x-provider'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Dropdown, Typography, theme, type MenuProps } from 'antd'
import { clsx } from 'clsx'
import {
  NATIVE_LIST_MAX_ROWS,
  SIDEBAR_OVERSCAN,
  type ConversationListRow,
} from './conversationListModel'

// Virtual row markup is derived from @ant-design/x Conversations 2.4.0.
// Its MIT notice is retained in ANT_DESIGN_X_LICENSE next to this file.

type ConversationContentRow = Exclude<ConversationListRow, { type: 'groupHeader' }>

const DEFERRED_MENU_ITEMS: NonNullable<MenuProps['items']> = [{
  key: '__aqbot_deferred_menu__',
  label: null,
  disabled: true,
  style: { display: 'none' },
}]

export type ConversationMenuConfig = MenuProps & {
  trigger?: React.ReactNode | ((conversation: ConversationItemType, info: {
    originNode: React.ReactNode
  }) => React.ReactNode)
  getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement
}

export type ConversationMenuFactory = (
  item: ConversationItemType,
  options?: { includeItems: boolean },
) => ConversationMenuConfig

interface ConversationListProps {
  rows: readonly ConversationListRow[]
  activeKey?: string
  onActiveChange: (key: string, item?: ConversationItemType) => void
  getItem: (row: ConversationContentRow) => ConversationItemType
  menu?: ConversationMenuFactory
  renderGroupLabel: (group: string) => React.ReactNode
  onGroupToggle: (group: string) => void
  nativeGroupable: GroupableProps
  scrollElementRef: RefObject<HTMLElement | null>
}

function toNativeItems(
  rows: readonly ConversationListRow[],
  getItem: ConversationListProps['getItem'],
): ConversationItemType[] {
  const items: ConversationItemType[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.type !== 'groupHeader') {
      items.push(getItem(row))
      continue
    }

    const next = rows[index + 1]
    if (!next || next.type === 'groupHeader') {
      items.push({
        key: `__collapsed_${row.group}`,
        group: row.group,
        label: null,
        disabled: true,
        style: { display: 'none' },
      })
    }
  }
  return items
}

function stopPropagation(event: React.MouseEvent) {
  event.stopPropagation()
}

function mergeVirtualItemStyle(
  virtualStyle: React.CSSProperties,
  itemStyle: React.CSSProperties | undefined,
): React.CSSProperties {
  const virtualPadding = virtualStyle.paddingInlineStart
  const itemPadding = itemStyle?.paddingInlineStart
  const additivePadding = typeof virtualPadding === 'number' && typeof itemPadding === 'number'
    ? virtualPadding + itemPadding
    : itemPadding ?? virtualPadding
  return {
    ...virtualStyle,
    ...itemStyle,
    ...(additivePadding !== undefined ? { paddingInlineStart: additivePadding } : {}),
  }
}

interface VirtualConversationItemProps {
  info: ConversationItemType
  active: boolean
  prefixCls: string
  direction: 'ltr' | 'rtl' | undefined
  menu?: ConversationMenuFactory
  onClick: ConversationListProps['onActiveChange']
  style: React.CSSProperties
}

/**
 * DOM and class contract derived from @ant-design/x 2.4.0 Conversations.Item.
 * Ant Design X is MIT licensed; keeping this local lets virtualization preserve
 * the native row structure while only constructing menus for mounted rows.
 */
function VirtualConversationItem({
  info,
  active,
  prefixCls,
  direction,
  menu,
  onClick,
  style,
}: VirtualConversationItemProps) {
  const [menuArmed, setMenuArmed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuConfig = menuArmed ? menu?.(info, { includeItems: menuOpen }) : undefined
  const { trigger, getPopupContainer, ...dropdownMenu } = menuConfig ?? {}
  const renderedDropdownMenu = menuConfig && !menuOpen
    ? { ...dropdownMenu, items: DEFERRED_MENU_ITEMS }
    : dropdownMenu
  const {
    key: _key,
    label,
    icon,
    disabled,
    group: _group,
    className,
    style: itemStyle,
    ...domProps
  } = info

  const triggerNode = (
    <EllipsisOutlined onClick={stopPropagation} className={`${prefixCls}-menu-icon`} />
  )
  const renderedTrigger = trigger
    ? typeof trigger === 'function'
      ? trigger(info, { originNode: triggerNode })
      : trigger
    : triggerNode

  return (
    <li
      {...domProps}
      title={typeof label === 'object' ? undefined : String(label ?? '')}
      className={clsx(className, `${prefixCls}-item`, {
        [`${prefixCls}-item-active`]: active && !disabled,
        [`${prefixCls}-item-disabled`]: disabled,
      })}
      style={mergeVirtualItemStyle(style, itemStyle)}
      onPointerEnter={() => setMenuArmed(true)}
      onClick={() => {
        if (!disabled) onClick(String(info.key), info)
      }}
    >
      {icon && <div className={`${prefixCls}-icon`}>{icon}</div>}
      <Typography.Text className={`${prefixCls}-label`}>{label}</Typography.Text>
      {!disabled && menuConfig && (
        <div onClick={stopPropagation}>
          <Dropdown
            menu={renderedDropdownMenu}
            placement={direction === 'rtl' ? 'bottomLeft' : 'bottomRight'}
            trigger={['click']}
            getPopupContainer={getPopupContainer}
            onOpenChange={setMenuOpen}
          >
            {renderedTrigger}
          </Dropdown>
        </div>
      )}
    </li>
  )
}

function VirtualConversationList({
  rows,
  activeKey,
  onActiveChange,
  getItem,
  menu,
  renderGroupLabel,
  onGroupToggle,
  scrollElementRef,
}: Omit<ConversationListProps, 'nativeGroupable'>) {
  const { token } = theme.useToken()
  const { getPrefixCls, direction } = useXProviderContext()
  const prefixCls = getPrefixCls('conversations')
  const [hashId, cssVarCls] = useConversationsStyle(prefixCls)
  const rowHeight = token.controlHeightLG
  const rowGap = token.paddingXXS
  const rootPadding = token.paddingSM
  const getRowPitch = (index: number) => {
    const row = rows[index]
    return row.type === 'groupHeader' && !row.collapsible
      ? rowHeight
      : rowHeight + rowGap
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: getRowPitch,
    getItemKey: (index) => rows[index].key,
    overscan: SIDEBAR_OVERSCAN,
  })
  const activeIndexByKey = useMemo(() => {
    const indices = new Map<string, number>()
    rows.forEach((row, index) => {
      if (row.type === 'conversation') indices.set(row.conversation.id, index)
    })
    return indices
  }, [rows])

  useEffect(() => {
    if (!activeKey) return
    const index = activeIndexByKey.get(activeKey)
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [activeIndexByKey, activeKey, virtualizer])

  const totalHeight = Math.max(
    0,
    virtualizer.getTotalSize() - rowGap + rootPadding * 2,
  )
  const rowStyle = (start: number): React.CSSProperties => ({
    position: 'absolute',
    top: rootPadding,
    insetInlineStart: rootPadding,
    width: `calc(100% - ${rootPadding * 2}px)`,
    height: rowHeight,
    transform: `translateY(${start}px)`,
  })

  return (
    <ul
      className={clsx(prefixCls, hashId, cssVarCls, {
        [`${prefixCls}-rtl`]: direction === 'rtl',
      })}
      data-list-mode="virtual"
      style={{
        position: 'relative',
        boxSizing: 'border-box',
        height: totalHeight,
        minHeight: totalHeight,
        overflow: 'visible',
        flex: 'none',
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index]
        const style = rowStyle(virtualRow.start)

        if (row.type === 'groupHeader') {
          return (
            <li key={virtualRow.key} style={style}>
              <div
                className={clsx(`${prefixCls}-group-title`, {
                  [`${prefixCls}-group-title-collapsible`]: row.collapsible,
                })}
                onClick={() => row.collapsible && onGroupToggle(row.group)}
              >
                <div className={`${prefixCls}-group-label`}>
                  {renderGroupLabel(row.group)}
                </div>
                {row.collapsible && (
                  <div className={clsx(
                    `${prefixCls}-group-collapse-trigger`,
                    `${prefixCls}-group-collapse-trigger-${row.expanded ? 'open' : 'close'}`,
                  )}>
                    <RightOutlined />
                  </div>
                )}
              </div>
            </li>
          )
        }

        const item = getItem(row)
        return (
          <VirtualConversationItem
            key={virtualRow.key}
            info={item}
            active={activeKey === String(item.key)}
            prefixCls={prefixCls}
            direction={direction}
            menu={menu}
            onClick={onActiveChange}
            style={{
              ...style,
              ...(row.group.startsWith('cat:')
                ? { paddingInlineStart: token.paddingXL }
                : {}),
            }}
          />
        )
      })}
    </ul>
  )
}

interface NativeConversationListProps {
  items: ConversationItemType[]
  activeKey?: string
  onActiveChange: ConversationListProps['onActiveChange']
  groupable: GroupableProps
  menu?: ConversationMenuFactory
}

function NativeConversationList({
  items,
  activeKey,
  onActiveChange,
  groupable,
  menu,
}: NativeConversationListProps) {
  const [armedMenuKey, setArmedMenuKey] = useState<string | null>(null)
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  const armMenuForPointerTarget = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const item = target.closest<HTMLElement>('[data-conv-id]')
    const itemKey = item?.dataset.convId
    if (itemKey) {
      setArmedMenuKey((current) => current === itemKey ? current : itemKey)
    }
  }, [])

  useEffect(() => {
    if (armedMenuKey === null) return

    const clearArmedMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setArmedMenuKey(null)
        setOpenMenuKey(null)
      }
    }
    document.addEventListener('keydown', clearArmedMenuOnEscape, true)
    return () => {
      document.removeEventListener('keydown', clearArmedMenuOnEscape, true)
    }
  }, [armedMenuKey])

  useEffect(() => {
    if (openMenuKey === null) return
    const clearClosedMenu = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.ant-dropdown')) return
      if (target.closest<HTMLElement>('[data-conv-id]')?.dataset.convId === openMenuKey) return
      setOpenMenuKey(null)
    }
    document.addEventListener('pointerdown', clearClosedMenu, true)
    return () => document.removeEventListener('pointerdown', clearClosedMenu, true)
  }, [openMenuKey])

  const nativeMenu = useMemo(() => {
    if (!menu) return undefined

    return (item: ConversationItemType): ConversationMenuConfig | undefined => {
      const itemKey = String(item.key)
      if (armedMenuKey !== itemKey) return undefined
      const menuConfig = menu(item, { includeItems: openMenuKey === itemKey })
      const originalTrigger = menuConfig.trigger
      const originalMenuClick = menuConfig.onClick

      return {
        ...menuConfig,
        items: openMenuKey === itemKey
          ? menuConfig.items
          : DEFERRED_MENU_ITEMS,
        onClick: (info) => {
          originalMenuClick?.(info)
          setArmedMenuKey(null)
          setOpenMenuKey(null)
        },
        trigger: (conversation, info) => {
          const renderedTrigger = typeof originalTrigger === 'function'
            ? originalTrigger(conversation, info)
            : originalTrigger ?? info.originNode
          const openDeferredMenu = () => {
            queueMicrotask(() => {
              setOpenMenuKey((current) => current === itemKey ? null : itemKey)
            })
          }
          if (!isValidElement<{ onClickCapture?: MouseEventHandler }>(renderedTrigger)) {
            return <span onClickCapture={openDeferredMenu}>{renderedTrigger}</span>
          }
          const originalClickCapture = renderedTrigger.props.onClickCapture
          return cloneElement(renderedTrigger, {
            onClickCapture: (event) => {
              originalClickCapture?.(event)
              openDeferredMenu()
            },
          })
        },
      }
    }
  }, [armedMenuKey, menu, openMenuKey])

  return (
    <div
      style={{ display: 'contents' }}
      // Arm from the stable list root before Dropdown receives pointerdown.
      // Replacing a trigger during pointerdown cancels Ant's opening click.
      onPointerOverCapture={armMenuForPointerTarget}
    >
      <Conversations
        data-list-mode="native"
        items={items}
        activeKey={activeKey}
        onActiveChange={(key, item) => {
          onActiveChange(key, item as ConversationItemType | undefined)
        }}
        groupable={groupable}
        menu={nativeMenu}
      />
    </div>
  )
}

export function ConversationList(props: ConversationListProps) {
  const { rows, getItem, nativeGroupable } = props
  const nativeItems = useMemo(
    () => rows.length <= NATIVE_LIST_MAX_ROWS ? toNativeItems(rows, getItem) : [],
    [getItem, rows],
  )

  if (rows.length <= NATIVE_LIST_MAX_ROWS) {
    return (
      <NativeConversationList
        items={nativeItems}
        activeKey={props.activeKey}
        onActiveChange={props.onActiveChange}
        groupable={nativeGroupable}
        menu={props.menu}
      />
    )
  }

  return <VirtualConversationList {...props} />
}
