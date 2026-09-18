'use client'

import type { ComponentPropsWithRef, PointerEvent as ReactPointerEvent, ReactNode } from 'react'

import { cn } from 'ui/lib/utils'

// Everything a plain `<div>` takes, on top of the row's own props. That is not
// convenience. This row gets handed to `asChild` triggers -- a context menu
// today, a tooltip or a dropdown as easily -- and such a trigger renders no
// element of its own: it clones its child and injects onto it the handlers and
// the ref its behaviour depends on. A child that names a fixed set of props and
// spreads nothing drops them, and the trigger is then wired to nothing. No
// error, no warning, and the menu simply never opens.
//
// `title`, `children` and `onSelect` are dropped from the inherited set: a div
// names all three as well, with different meanings, and inheriting them would
// let two definitions of the same prop disagree quietly.
// The row's two text styles, exported as the one source for them. Anything
// that has to read as "the same line a list row draws" -- the thread header's
// agent line beside its breadcrumb, say -- imports these rather than spelling
// a matching class string, so the two cannot drift by one token.
export const LIST_ROW_TITLE_CLASS = 'truncate text-xs font-medium text-foreground'
export const LIST_ROW_SECONDARY_CLASS = 'truncate text-xs text-muted-foreground'

export interface ListRowProps extends Omit<ComponentPropsWithRef<'div'>, 'title' | 'children' | 'onSelect'> {
  // The first line. Truncates rather than wrapping, so a long title never
  // grows the row.
  title: ReactNode
  // The dimmed second line. Omitted, the row is a single line.
  secondary?: ReactNode
  // Before the text: an avatar, a cluster of them, an icon.
  leading?: ReactNode
  // After the text. For things that are READ, not pressed -- every action a row
  // offers beyond selecting it belongs in the row's context menu, which a long
  // press reaches on touch. A control that only appears on hover is not
  // reachable there at all.
  trailing?: ReactNode
  // The row the list is currently showing.
  active?: boolean
  // Dim the row and mark it disabled to assistive technology, without hiding
  // it. Selection still fires: the content stays readable, and gating what
  // acting on it means is the host's.
  disabled?: boolean
  onSelect?: () => void
  // Lands on the row element itself, which is also the element a wrapping
  // context-menu trigger attaches to. That placement is the point: the trigger
  // arms its own touch long-press behind a `defaultPrevented` check and runs
  // this handler first, so a host that cancels the event here suppresses that
  // long-press and keeps the menu on its own schedule. Nothing else reaches the
  // trigger in time -- an ancestor does not.
  //
  // Cancelling `pointerdown` also suppresses the click the browser would
  // synthesise from a tap, so a host that uses this owes the row its tap: it
  // has to act on selection itself. That is why this is passed in rather than
  // done here -- whatever takes the click away answers for it.
  //
  // Named rather than left to the spread below because a trigger injects one of
  // these too, and the two have to compose in this order. A trigger's `asChild`
  // merge already does that composing before this component is called.
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
  className?: string
}

// The shell a top-level list row is drawn in: a leading slot, a two-line
// truncating text stack, a trailing slot. Pressable, keyboard-activable, and it
// marks itself active -- and it owns the touch handling, which is the part that
// had actually gone wrong. Two lists drew this row from identical class strings
// and still supported different gestures, because the geometry is what gets
// compared and the gesture is not.
//
// `touch-action: pan-y` keeps a vertical scroll working while leaving a long
// press free for a wrapping context menu, and the callout/selection suppression
// stops the browser answering that same press with its own text selection.
// Unconditional, deliberately: it used to be a per-list decision, and one of the
// two lists had simply never made it.
//
// It renders one real element and puts everything it is given on it. A row that
// is the child of an `asChild` trigger IS that trigger; anything it fails to
// forward is a piece of the trigger's behaviour that silently does not exist.
//
// This is the TOP-LEVEL row. A row nested inside one -- smaller type, tighter
// radius, less padding -- is a different thing at a different scale, and pulling
// it onto this shell would make two things agree rather than make one thing
// exist once.
export function ListRow({
  title,
  secondary,
  leading,
  trailing,
  active = false,
  disabled = false,
  onSelect,
  onPointerDown,
  onClick,
  onKeyDown,
  style,
  className,
  ref,
  ...rest
}: ListRowProps) {
  return (
    <div
      // First, so that everything stated below wins over anything passed in:
      // the role, the touch handling and the active treatment are this
      // component's to decide, not a caller's. What this spread carries is
      // everything a wrapping trigger injects that this file does not name --
      // `onContextMenu`, the pointer handlers behind a touch long press,
      // `data-state` -- and that is the whole reason it is here.
      {...rest}
      ref={ref}
      role='button'
      tabIndex={0}
      // Nothing reads this any more, and driving the background from the prop
      // below is what made that true. Kept deliberately rather than by
      // oversight: a row's selected state is worth exposing to the DOM whether
      // or not this file styles from it, and a host stylesheet or a test has
      // nothing else to select on.
      data-active={active}
      aria-disabled={disabled}
      // A caller's style is merged UNDER the row's own, not over it: the touch
      // rules above are unconditional by design, and letting a caller drop
      // `touch-action` would restore the per-list gesture drift this component
      // exists to end.
      style={{ ...style, touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' }}
      onPointerDown={onPointerDown}
      // Composed, not replaced. A context-menu trigger injects neither of these,
      // but a dropdown or tooltip trigger injects both -- and the row's own
      // selection behaviour and the trigger's must each survive the other.
      onClick={(event) => {
        onClick?.(event)
        onSelect?.()
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect?.()
        }
      }}
      className={cn(
        'relative flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left outline-none transition-colors',
        'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        // Both copies of this row used to select the active background through a
        // bracketed attribute variant. A literal class behind the prop always
        // gets generated, so it cannot go quietly inert the way a composed
        // selector can -- which is the trade worth making.
        //
        // It IS a trade, and the conditions are worth stating rather than
        // leaving for someone to rediscover. This is a plain utility where the
        // variant carried an attribute selector, so it now ranks BELOW any
        // `hover:` rule instead of above it -- invisible today only because the
        // hover on the line above resolves to the same token. And because `cn`
        // merges last-wins, a consumer passing its own `bg-*` takes the active
        // background away rather than layering over it. Nothing in the kit
        // triggers either; both are conditions, not guarantees.
        active && 'bg-muted',
        disabled && 'opacity-60',
        className,
      )}
    >
      {leading}
      <span className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
        <span className={LIST_ROW_TITLE_CLASS}>{title}</span>
        {secondary ? <span className={LIST_ROW_SECONDARY_CLASS}>{secondary}</span> : null}
      </span>
      {trailing}
    </div>
  )
}
