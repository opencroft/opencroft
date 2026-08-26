'use client'

import { ChevronLeft, ChevronRight, Pencil, RotateCcw, X } from 'lucide-react'

import { Button } from 'ui/components/ui/button'
import { cn } from 'ui/lib/utils'

export interface ChatEditBarProps {
  /** What the selected message ORIGINALLY said, before this edit began.
   *
   * Display-only, and that is the whole of its job: the composer below holds
   * the text being changed, so the one thing the reader cannot otherwise see
   * is what they are changing it FROM. One line, truncated — it is a reminder,
   * not a second editor. */
  original: string
  /** Which message of the turn is open, 0-based, and how many there are.
   *
   * A turn can carry several messages: a reader sends more while the agent is
   * busy and they are handed over together. The composer holds one of them at
   * a time, and this says which. */
  index: number
  count: number
  /** Page to the previous/next message of the turn. Rendered only when there
   *  is more than one — a single-message turn uses this same bar with no pager,
   *  rather than a second bar of its own. */
  onPrev: () => void
  onNext: () => void
  /** Put the SELECTED message back to what it originally said. Only that one:
   *  the reader is looking at one message, and a reset that silently reverted
   *  the others would undo work that is not on screen. */
  onReset: () => void
  /** Leave edit mode, dropping every pending edit in the turn. The counterpart
   *  of committing them all at once from the composer. */
  onCancel: () => void
  className?: string
}

// Matching metric for the row's controls. Smaller than the composer's own
// action row underneath: this strip is context for what is being typed, and a
// row of full-size buttons above the input reads as a second toolbar competing
// with the real one.
const editBarControlClass = 'size-6 shrink-0'

/**
 * The bar above the composer while a delivered turn is being edited.
 *
 * One row: what mode this is, what the open message originally said, where it
 * sits in the turn, and the two ways out — put this one back, or abandon all of
 * them. Committing is deliberately NOT here; it belongs to the composer's own
 * send control, because committing is what sending an edit IS.
 *
 * **Fully controlled, and it owns no draft.** It never sees the text being
 * typed — that lives in the composer — so paging away from a half-edited
 * message cannot lose anything through this component. What survives a page is
 * the host's business, and the host is where the drafts are.
 *
 * The treatment follows the thread-name strip a group chat carries above its
 * conversation: one row, muted, a truncating middle that yields all its width,
 * and controls that take only what they need. A reader meets both in the same
 * chat, and a second visual language for "a strip that says where you are" is
 * one more thing to learn for nothing.
 *
 * Every control keeps the composer focused (`onMouseDown` preventDefault), for
 * the same reason the composer's own row does — the caret is in a sentence the
 * reader is in the middle of, and paging, resetting or reaching for the pager
 * should not take it away from them.
 */
export function ChatEditBar({
  original,
  index,
  count,
  onPrev,
  onNext,
  onReset,
  onCancel,
  className,
}: ChatEditBarProps) {
  return (
    <div
      className={cn('flex min-w-0 items-center gap-1 px-1 text-xs text-muted-foreground', className)}
      // Named as a group so the pager and the original text are reachable as
      // one thing rather than as loose controls above a textarea.
      role='group'
      aria-label='Editing a message'
    >
      <span className='flex shrink-0 items-center gap-1 font-medium text-foreground'>
        <Pencil className='size-3.5' />
        Edit
      </span>

      {/* Takes the width nobody else needs and gives it all back under
          pressure: `min-w-0` is what lets `truncate` engage at all, since
          overflow:hidden is what drops the automatic minimum size to zero. The
          full text is on the title, so a truncated line is still readable
          without leaving the bar. */}
      <span className='min-w-0 flex-1 truncate' title={original}>
        {original}
      </span>

      {/* The pager exists only when there is something to page through. A
          "1 / 1" would be a control that cannot do anything, sitting next to two
          that can. */}
      {count > 1 ? (
        <span className='flex shrink-0 items-center gap-0.5'>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className={editBarControlClass}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onPrev}
            disabled={index <= 0}
            title='Previous message'
            aria-label='Previous message'
          >
            <ChevronLeft className='size-3.5' />
          </Button>
          {/* Tabular figures so the number does not shuffle its neighbours as
              it changes. Announced as a sentence rather than as "2 / 3", which
              is read aloud as arithmetic. */}
          <span className='tabular-nums' aria-label={`Message ${index + 1} of ${count}`}>
            {index + 1} / {count}
          </span>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className={editBarControlClass}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onNext}
            disabled={index >= count - 1}
            title='Next message'
            aria-label='Next message'
          >
            <ChevronRight className='size-3.5' />
          </Button>
        </span>
      ) : null}

      <Button
        type='button'
        size='icon'
        variant='ghost'
        className={editBarControlClass}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onReset}
        title='Reset this message'
        aria-label='Reset this message'
      >
        <RotateCcw className='size-3.5' />
      </Button>

      <Button
        type='button'
        size='icon'
        variant='ghost'
        className={editBarControlClass}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onCancel}
        title='Stop editing'
        aria-label='Stop editing'
      >
        <X className='size-3.5' />
      </Button>
    </div>
  )
}
