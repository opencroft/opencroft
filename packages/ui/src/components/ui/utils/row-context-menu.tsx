'use client'

import { isValidElement, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from 'ui/components/ui/context-menu'

export interface RowMenuEntry {
  label: string
  onSelect: () => void
  icon?: ReactNode
  // Draws the entry destructively. `onDelete` already does this for the
  // canonical Delete; this is for a second destructive act a host owns.
  destructive?: boolean
  // Only needed when two entries share a label.
  key?: string
}

export interface RowContextMenuProps {
  // The row. It becomes the trigger -- handed to the trigger's `render`, so the
  // trigger draws no element of its own and merges its handlers and ref onto
  // the row's -- and it keeps its own click, keyboard and drag behaviour: this
  // adds a menu to a row rather than wrapping it in one. The row therefore has
  // to spread the props it is given and forward its ref (ListRow does). Anything
  // that is not a single element is wrapped in the trigger's own `<div>`.
  children: ReactNode
  entries?: RowMenuEntry[]
  // The canonical destructive Delete, always last. Given as its own prop rather
  // than as an entry so that every list in the kit deletes with the same
  // wording, the same icon and in the same position -- which is the whole
  // reason this component exists. The kit never confirms: what is being
  // destroyed, and whether that is worth a dialog, is the host's knowledge.
  onDelete?: () => void
  // Locks the menu (Base UI takes `disabled` on the context-menu root, not the
  // trigger). While it is set the trigger ignores `contextmenu` and declines to
  // arm its touch long-press on `touchstart` -- which is how a host that runs its
  // own press gesture takes the menu's timing over. It does NOT clear a
  // long-press timer already armed before it was set, so a host has to set it
  // before the touch starts (a `pointerdown` on the row is early enough).
  disabled?: boolean
  // A notification, not a handle. The context-menu primitive owns its open
  // state and takes no controlled `open`: it opens from a `contextmenu` event
  // and nothing else.
  onOpenChange?: (open: boolean) => void
}

// The menu a list row carries: right-click on a pointer, long press on touch.
//
// This existed three times over -- in chat-list-item, in chat-list's folder
// header and in group-chat-list -- with the same width, the same click guard
// and the same destructive Delete copied between them. Three copies of a guard
// is three chances to forget it.
//
// **The click guard is the load-bearing part.** The row underneath is itself a
// button, so without `stopPropagation` on the content a press on Delete falls
// through and selects the very row being deleted. It is not styling, and it is
// exactly the kind of thing that goes missing from the fourth copy.
//
// With no entries and no `onDelete` the row is returned untouched, so a host
// that offers no actions renders exactly what it did before this existed.
export function RowContextMenu({ children, entries, onDelete, disabled = false, onOpenChange }: RowContextMenuProps) {
  const hasMenu = Boolean(entries?.length || onDelete)

  if (!hasMenu) {
    return <>{children}</>
  }

  return (
    <ContextMenu onOpenChange={onOpenChange} disabled={disabled}>
      {isValidElement(children) ? (
        <ContextMenuTrigger render={children} />
      ) : (
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
      )}
      {/* `min-w-32` is the scale utility for 8rem -- the identical width the
          three copies spelled as an arbitrary `min-w-[8rem]`. A scale class is
          a literal, so it always renders; an arbitrary one renders only where
          the same string happens to appear in a file the build scans, and the
          kit is never scanned. Same width, no coincidence -- and the same
          class the other two menus in this project already use.

          The shadcn primitive may well apply the same minimum itself, in which
          case this is redundant rather than wrong; it is stated here because
          the three copies stated it, and dropping it on a guess would silently
          narrow every menu in the kit. */}
      <ContextMenuContent className='min-w-32' onClick={(event) => event.stopPropagation()}>
        {entries?.map((entry) => (
          <ContextMenuItem
            key={entry.key ?? entry.label}
            className={entry.destructive ? 'text-destructive focus:text-destructive' : undefined}
            onClick={entry.onSelect}
          >
            {entry.icon}
            {entry.label}
          </ContextMenuItem>
        ))}
        {onDelete ? (
          <ContextMenuItem className='text-destructive focus:text-destructive' onClick={onDelete}>
            <Trash2 className='size-3' />
            Delete
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
