import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpToLine,
  type LucideIcon,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Trash2,
} from 'lucide-react'
import { type ComponentType, Fragment, type ReactNode } from 'react'
import { ContextMenuItem, ContextMenuSeparator } from 'ui/components/ui/context-menu'
import { DropdownMenuItem, DropdownMenuSeparator } from 'ui/components/ui/dropdown-menu'

import type { MarkdownTableAlign, MarkdownTableCommand } from './markdown-table'

/*
 * What the editable table's menus offer, as data: the grip menus and the cell's
 * context menu read the same lists, so they always offer the same thing in the
 * same order.
 */

export type Axis = 'row' | 'column'

interface Action {
  label: string
  icon: LucideIcon
  destructive?: boolean
  /** The command for the row or column at `index` of `count`; null where it cannot apply. */
  command: (index: number, count: number) => MarkdownTableCommand | null
}

/** One list per axis, in groups a separator splits. */
export const ACTIONS: Record<Axis, Action[][]> = {
  row: [
    [
      { label: 'Insert row above', icon: ArrowUpToLine, command: (index) => ({ type: 'insertRow', index }) },
      { label: 'Insert row below', icon: ArrowDownToLine, command: (index) => ({ type: 'insertRow', index: index + 1 }) },
    ],
    [
      {
        label: 'Move row up',
        icon: ArrowUp,
        command: (index) => (index > 0 ? { type: 'moveRow', from: index, to: index - 1 } : null),
      },
      {
        label: 'Move row down',
        icon: ArrowDown,
        command: (index, count) => (index < count - 1 ? { type: 'moveRow', from: index, to: index + 1 } : null),
      },
    ],
    [
      {
        label: 'Delete row',
        icon: Trash2,
        destructive: true,
        command: (index, count) => (count > 1 ? { type: 'deleteRow', index } : null),
      },
    ],
  ],
  column: [
    [
      {
        label: 'Insert column left',
        icon: ArrowLeftToLine,
        command: (index) => ({ type: 'insertColumn', index }),
      },
      {
        label: 'Insert column right',
        icon: ArrowRightToLine,
        command: (index) => ({ type: 'insertColumn', index: index + 1 }),
      },
    ],
    [
      {
        label: 'Move column left',
        icon: ArrowLeft,
        command: (index) => (index > 0 ? { type: 'moveColumn', from: index, to: index - 1 } : null),
      },
      {
        label: 'Move column right',
        icon: ArrowRight,
        command: (index, count) => (index < count - 1 ? { type: 'moveColumn', from: index, to: index + 1 } : null),
      },
    ],
    [
      {
        label: 'Delete column',
        icon: Trash2,
        destructive: true,
        command: (index, count) => (count > 1 ? { type: 'deleteColumn', index } : null),
      },
    ],
  ],
}

export const ALIGNS: { align: MarkdownTableAlign; label: string; icon: LucideIcon }[] = [
  { align: 'left', label: 'Align left', icon: TextAlignStart },
  { align: 'center', label: 'Align center', icon: TextAlignCenter },
  { align: 'right', label: 'Align right', icon: TextAlignEnd },
]

export const DELETE_TABLE: Action = {
  label: 'Delete table',
  icon: Trash2,
  destructive: true,
  command: () => ({ type: 'deleteTable' }),
}

/** The menu primitive's item and separator, so one list renders into either kind of menu. */
interface MenuParts {
  Item: ComponentType<{
    onClick?: () => void
    disabled?: boolean
    variant?: 'default' | 'destructive'
    children?: ReactNode
  }>
  Separator: ComponentType
}

export const DROPDOWN: MenuParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator }
export const CONTEXT: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator }

export function ActionItem({
  action,
  index,
  count,
  onCommand,
  parts,
}: {
  action: Action
  index: number
  count: number
  onCommand: (command: MarkdownTableCommand) => void
  parts: MenuParts
}) {
  const command = action.command(index, count)
  const Icon = action.icon
  return (
    <parts.Item
      disabled={!command}
      variant={action.destructive ? 'destructive' : 'default'}
      onClick={() => command && onCommand(command)}
    >
      <Icon />
      {action.label}
    </parts.Item>
  )
}

export function ActionGroups({
  groups,
  index,
  count,
  onCommand,
  parts,
}: {
  groups: Action[][]
  index: number
  count: number
  onCommand: (command: MarkdownTableCommand) => void
  parts: MenuParts
}) {
  return groups.map((group, groupIndex) => (
    <Fragment key={group[0].label}>
      {groupIndex > 0 ? <parts.Separator /> : null}
      {group.map((action) => (
        <ActionItem
          key={action.label}
          action={action}
          index={index}
          count={count}
          onCommand={onCommand}
          parts={parts}
        />
      ))}
    </Fragment>
  ))
}
