'use client'

import { ChevronRight, Pencil, Pin, Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

// Word for word the server's `pin-limit` refusal. The panel stops the press
// early where it can, but two members pinning at the same instant both pass the
// count check and one comes back refused -- and the person who sees both should
// not be reading two different sentences about one rule.
const CAP_MESSAGE =
  'This group chat already holds the maximum number of pins. Unpin one to add another.'

export interface GroupChatPin {
  id: string
  text: string
}

export interface GroupChatPinsProps {
  pins: GroupChatPin[]
  /** How many may be pinned at once. The cap exists because every pin is
   * injected into the agents' context, so it is bounded on purpose -- and it is
   * spent VISIBLY here: at the cap the add goes inert and says why, rather than
   * letting the press travel and come back refused. */
  max?: number
  /** Compose a new note. The host owns what this opens -- a dialog, an inline
   * panel -- and the kit ships the form for it (group-chat-pin-form). Omit and
   * no add affordance is drawn. */
  onPin?: () => void
  /** Edit one. Omit and the note text is plain text, not a button. */
  onEditPin?: (id: string) => void
  /** Unpin one. This DESTROYS the note -- there is no unpinned-notes shelf to
   * recover it from -- so a host that wants a confirmation puts one here. The
   * kit does not confirm on its behalf: it would be the only confirm in this
   * family, and a wrong one is worse than none. */
  onUnpin?: (id: string) => void
  /** Why the add is inert at the cap. Defaults to the server's own `pin-limit`
   * refusal copy, word for word, so the press this panel stops early and the
   * press that loses a race to another member read identically. Overridable
   * only so the two can be kept in step if the server's wording changes. */
  capMessage?: string
  /** A whole-panel failure: a refused pin, an unpin that did not land. */
  error?: string
  /** Open on first render. Defaults to CLOSED -- see the note in the docs. */
  defaultOpen?: boolean
  /** Controlled open state, for a host that wants to own it. Radix owns the
   * uncontrolled case, so there is no local state to fall out of step. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

// The standing notes pinned to a group chat.
//
// CLOSED by default (product call, 2026-08-07): standing notes must not eat the
// thread area, which is what the screen is for. What makes that safe rather
// than merely tidy is that the collapsed state is not silent -- it states the
// count, so "3 pinned notes" is itself the announcement that this chat carries
// standing guidance, and opening it is one press. A collapsed panel that said
// nothing would hide from a reader the very thing the chat's agents are being
// told.
//
// The height bound stays, and it is doing a different job now: it stops an
// OPENED panel from swallowing the threads, so ten notes cost the same vertical
// space as three and the person who opened it does not have to close it again
// to get their screen back.
//
// Any member may pin, edit and unpin ANY note -- the same symmetric rule as
// membership -- so nothing here carries admin framing, and no note is drawn as
// somebody else's.
export function GroupChatPins({
  pins,
  max = 10,
  onPin,
  onEditPin,
  onUnpin,
  capMessage = CAP_MESSAGE,
  error,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
}: GroupChatPinsProps) {
  const count = pins.length
  const atCap = count >= max
  const summary =
    count === 0 ? 'Nothing pinned' : count === 1 ? '1 pinned note' : `${count} pinned notes`

  return (
    <Collapsible
      // Uncontrolled unless the host passes `open`: Radix holds the state
      // either way, so there is no second copy of it here to drift.
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
      className={cn('group/pins flex min-w-0 flex-col', className)}
    >
      <div className='flex min-w-0 items-center gap-2'>
        {count > 0 ? (
          // The whole summary is the toggle, not the chevron alone -- the same
          // reasoning as the header lines on the detail screen: a 14px glyph is
          // a poor press target and the text beside it is a good one.
          <CollapsibleTrigger className='-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'>
            <Pin className='size-3.5 shrink-0' aria-hidden='true' />
            <span className='truncate'>{summary}</span>
            <ChevronRight
              className='size-3.5 shrink-0 transition-transform group-data-[state=open]/pins:rotate-90'
              aria-hidden='true'
            />
          </CollapsibleTrigger>
        ) : (
          // Nothing to expand, so nothing that behaves like it can be. The line
          // stays rather than the panel disappearing: it is the only place the
          // feature announces itself to someone who has never pinned anything.
          <span className='-ml-1.5 flex min-w-0 items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground'>
            <Pin className='size-3.5 shrink-0' aria-hidden='true' />
            <span className='truncate'>{summary}</span>
          </span>
        )}
        <span className='flex-1' />
        {onPin ? (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='shrink-0'
            disabled={atCap}
            onClick={onPin}
          >
            <Plus /> Pin a note
          </Button>
        ) : null}
      </div>

      {/* Why the add is inert, in words, always visible -- a disabled control
          with the reason on a tooltip is a dead end on a touch device, which is
          where this strip is tightest. It also names the way out (unpin one)
          rather than only stating the rule, and it wraps rather than truncating
          because a reason nobody can finish reading is not one. */}
      {atCap && onPin ? (
        <p className='min-w-0 px-1.5 pt-0.5 text-xs wrap-break-word text-muted-foreground'>
          {capMessage}
        </p>
      ) : null}

      <CollapsibleContent>
        {/* Height-capped and scrolling inside itself: an OPENED panel costs the
            same whether two notes are pinned or ten, so opening it is not a
            decision anyone has to undo to get the thread list back. */}
        <ul className='mt-1 flex max-h-40 min-w-0 flex-col gap-0.5 overflow-y-auto'>
          {pins.map((pin) => (
            <li key={pin.id} className='flex min-w-0 items-start gap-1'>
              {onEditPin ? (
                <button
                  type='button'
                  onClick={() => onEditPin(pin.id)}
                  aria-label={`Edit pinned note: ${pin.text}`}
                  className='-ml-1.5 flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring'
                >
                  {/* Notes wrap in full rather than truncating: a pin exists to
                      be read, and a half-read reminder is not one. Line breaks
                      the author typed are kept. */}
                  <span className='min-w-0 flex-1 whitespace-pre-wrap wrap-break-word'>{pin.text}</span>
                  <Pencil className='mt-0.5 size-3 shrink-0 text-muted-foreground' aria-hidden='true' />
                </button>
              ) : (
                <span className='-ml-1.5 min-w-0 flex-1 px-1.5 py-1 text-xs whitespace-pre-wrap wrap-break-word text-foreground'>
                  {pin.text}
                </span>
              )}
              {onUnpin ? (
                // Separated from the text on purpose: the text is pressed to
                // edit and this is pressed to destroy, so they do not share an
                // edge. Never hover-revealed -- it would not exist on touch.
                <button
                  type='button'
                  onClick={() => onUnpin(pin.id)}
                  aria-label={`Unpin note: ${pin.text}`}
                  className='mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring'
                >
                  <X className='size-3.5' />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </CollapsibleContent>

      {/* Outside the collapsible content: a failure the panel is collapsed over
          is a failure nobody sees. */}
      {error ? (
        <p role='alert' className='px-1.5 pt-1 text-xs text-destructive'>
          {error}
        </p>
      ) : null}
    </Collapsible>
  )
}
