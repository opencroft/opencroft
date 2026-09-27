'use client'

import type { MouseEvent, ReactNode, SyntheticEvent } from 'react'

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from 'ui/components/ui/context-menu'
import { cn } from 'ui/lib/utils'

export type ReferenceChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted'

export interface ReferenceChipMenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
}

export interface ReferenceChipProps {
  /**
   * What the chip names -- a key, a name. Never truncated, so keep it short
   * and put anything long in `detail`. Before anything is known about the
   * identifier this is the identifier itself, so the chip reads correctly
   * from the first paint and only gains detail afterwards.
   */
  label: string
  /** Text after the label -- a task's summary. The first thing to truncate. */
  detail?: string
  /**
   * The thing's state as its owner draws it -- a task's status badge --
   * first, on the left. Truncated only once `detail` has nothing left.
   */
  state?: ReactNode
  /**
   * Leading mark. A lucide icon handed over bare is sized by the chip; a
   * composed mark (an owner's own type glyph) is drawn exactly as given.
   */
  icon?: ReactNode
  /** A state dot after the label, for a state with no drawing of its own. */
  tone?: ReferenceChipTone
  /** The state in words, for assistive technology and beside the dot. */
  stateLabel?: string
  /**
   * `pending`: nothing is known yet. `resolved`: the label and state are the
   * thing's own. `unknown`: it was looked up and nothing answers to it -- the
   * chip stays, muted, rather than turning back into text and moving the line.
   */
  status?: 'pending' | 'resolved' | 'unknown'
  /** Where pressing it goes. The chip is then a real link. */
  href?: string
  /** What pressing it does, for a target that is not a page. */
  onOpen?: () => void
  /** Offered on right-click and long press; no menu when empty. */
  menu?: ReferenceChipMenuItem[]
  className?: string
}

// The chip's own look, as classes, for a surface that cannot render the
// component but has to draw the same chip: a text editor styles the identifier
// in place with these, so the chip being typed and the chip being read are
// one look.
export const REFERENCE_CHIP_CLASS =
  'inline-flex max-w-full items-baseline gap-1 rounded-md border border-border/70 bg-muted/60 px-1 py-px align-baseline text-[0.92em] leading-snug font-medium text-foreground no-underline'
export const REFERENCE_CHIP_UNKNOWN_CLASS = 'border-dashed bg-transparent font-normal text-muted-foreground'
export const REFERENCE_CHIP_ICON_CLASS =
  'inline-flex min-h-[1em] min-w-[1em] shrink-0 self-center items-center justify-center text-muted-foreground [&>svg]:size-[1em]'

const TONE_CLASS: Record<ReferenceChipTone, string> = {
  neutral: 'bg-muted-foreground',
  info: 'bg-sky-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-destructive',
  muted: 'bg-muted-foreground/40',
}

// The same dot, drawn after the text by the element itself, for a surface
// that styles text in place and has no element of its own to put a dot in.
const TONE_AFTER_CLASS: Record<ReferenceChipTone, string> = {
  neutral: 'after:bg-muted-foreground',
  info: 'after:bg-sky-500',
  success: 'after:bg-emerald-500',
  warning: 'after:bg-amber-500',
  danger: 'after:bg-destructive',
  muted: 'after:bg-muted-foreground/40',
}
const AFTER_DOT_CLASS =
  "after:ml-1 after:inline-block after:size-1.5 after:shrink-0 after:self-center after:rounded-full after:content-['']"

/** A tone's dot as classes on the chip's own element, for a chip drawn by `REFERENCE_CHIP_CLASS`. */
export function referenceChipToneClass(tone: ReferenceChipTone): string {
  return cn(AFTER_DOT_CLASS, TONE_AFTER_CLASS[tone])
}

// A menu inside a message sits inside the message's own menu. The chip's
// press is the chip's, so it goes no further than the chip.
const keepToChip = (event: SyntheticEvent) => event.stopPropagation()

// An identifier in text, drawn as the thing it names: a small inline chip
// with the thing's mark, its name and its state.
//
// INLINE, AT THE TEXT'S OWN SIZE. It sits inside a sentence, so it takes the
// sentence's size and baseline rather than a control's, and a long name
// truncates rather than widening the line -- or whatever holds the line.
//
// ONE PRESS OPENS. A real link when there is somewhere to go, a button when
// the host does something else; with neither it is only a label. Anything
// else it offers is in its context menu -- right-click, or a long press on
// touch -- and there is no menu at all when there is nothing to offer.
//
// THREE STATES, TOLD BY SHAPE AS WELL AS COLOUR. Pending shows the identifier
// as written; resolved shows the thing's own name and state; unknown keeps the
// identifier with a dashed edge and no fill.
//
// Presentational and fully controlled: finding, resolving and opening are the
// host's.
export function ReferenceChip({
  label,
  detail,
  state,
  icon,
  tone,
  stateLabel,
  status = 'resolved',
  href,
  onOpen,
  menu,
  className,
}: ReferenceChipProps) {
  const unknown = status === 'unknown'
  const classes = cn(
    REFERENCE_CHIP_CLASS,
    unknown && REFERENCE_CHIP_UNKNOWN_CLASS,
    (href || onOpen) && 'cursor-pointer hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
    className,
  )
  const content = (
    <>
      {/* Shrinks, but at a thousandth of the detail's rate, so it gives way
          only once the detail is gone. */}
      {state && !unknown ? <span className='inline-flex min-w-0 shrink self-center'>{state}</span> : null}
      {icon ? (
        <span className={REFERENCE_CHIP_ICON_CLASS} aria-hidden='true'>
          {icon}
        </span>
      ) : null}
      <span className='shrink-0 whitespace-nowrap'>{label}</span>
      {/* One line with an ellipsis, like `truncate`, but through a line clamp
          over wrappable text: a container that sizes itself to the narrowest
          its content allows (a transcript does) must be able to shrink the
          chip, and nowrap text would make the whole detail unbreakable. */}
      {detail ? (
        <span className='min-w-0 shrink-[1000] line-clamp-1 [overflow-wrap:anywhere]'>{detail}</span>
      ) : null}
      {tone && !unknown ? (
        <span className={cn('size-1.5 shrink-0 self-center rounded-full', TONE_CLASS[tone])} aria-hidden='true' />
      ) : null}
      {stateLabel ? <span className='sr-only'>{stateLabel}</span> : null}
    </>
  )
  const open = onOpen
    ? (event: MouseEvent) => {
        // A plain press opens here; a modified one on a link is the browser's
        // (a new tab, a download), as on any other link.
        if (href && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) {
          return
        }
        event.preventDefault()
        onOpen()
      }
    : undefined
  const chip = href ? (
    <a href={href} className={classes} onClick={open}>
      {content}
    </a>
  ) : onOpen ? (
    <button type='button' className={classes} onClick={open}>
      {content}
    </button>
  ) : (
    <span className={classes}>{content}</span>
  )
  if (!menu?.length) {
    return chip
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={chip}
        onContextMenu={keepToChip}
        onPointerDown={keepToChip}
        onTouchStart={keepToChip}
      />
      <ContextMenuContent>
        {menu.map((item) => (
          <ContextMenuItem key={item.label} onClick={item.onSelect}>
            {item.icon}
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
