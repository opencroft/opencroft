'use client'

import { Pencil, Plus, X } from 'lucide-react'
import { useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { GroupChatPinForm } from 'ui/components/ui/group-chat/group-chat-pin-form'
import { cn } from 'ui/lib/utils'

// Word for word the server's `pin-limit` refusal. The editor stops the press
// early where it can, but two members pinning at the same instant both pass
// the count check and one comes back refused -- and the person who sees both
// should not be reading two different sentences about one rule.
const CAP_MESSAGE = 'This group chat already holds the maximum number of pins. Unpin one to add another.'

export interface GroupChatPin {
  id: string
  text: string
}

export interface GroupChatPinsEditorProps {
  pins: GroupChatPin[]
  /** How many may be pinned at once. Bounded because every pin is injected
   * into the agents' context -- and spent VISIBLY: at the cap the add goes
   * inert and says why, rather than letting the press travel and come back
   * refused. */
  max?: number
  /** Pin a new note with this text. The editor closes its form once the
   * promise settles; a rejection is the host's to report through `error`. */
  onAdd: (text: string) => void | Promise<void>
  /** Save an edited note. Same contract as `onAdd`. */
  onEdit: (id: string, text: string) => void | Promise<void>
  /** Unpin one. This DESTROYS the note -- there is no unpinned-notes shelf to
   * recover it from -- so a host that wants a confirmation puts one here. */
  onUnpin: (id: string) => void
  /** A write in flight: the forms' submit goes inert. */
  pending?: boolean
  /** A failure to show: a refused pin, an unpin that did not land. */
  error?: string
  capMessage?: string
  className?: string
}

// The standing notes pinned to a group chat, edited where they are read.
//
// Opened from the header's pin toggle and drawn under it, so a note is one
// press away rather than two dialogs deep: press the pencil and the note's row
// becomes the form, press Pin a note and a form grows at the bottom. With no
// notes at all the form is simply there -- the panel was opened to write one,
// and a line saying nothing is pinned would only stand between the reader and
// the field.
//
// Any member may pin, edit and unpin ANY note -- the same symmetric rule as
// membership -- so nothing here carries admin framing, and no note is drawn as
// somebody else's.
export function GroupChatPinsEditor({
  pins,
  max = 10,
  onAdd,
  onEdit,
  onUnpin,
  pending = false,
  error,
  capMessage = CAP_MESSAGE,
  className,
}: GroupChatPinsEditorProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const atCap = pins.length >= max
  const composing = adding || (pins.length === 0 && !atCap)

  const beginEdit = (pin: GroupChatPin) => {
    setAdding(false)
    setEditingId(pin.id)
    setDraft(pin.text)
  }
  const beginAdd = () => {
    setEditingId(null)
    setAdding(true)
    setDraft('')
  }
  const cancel = () => {
    setEditingId(null)
    setAdding(false)
    setDraft('')
  }
  const submitEdit = async (id: string) => {
    await onEdit(id, draft)
    cancel()
  }
  const submitAdd = async () => {
    await onAdd(draft)
    cancel()
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {/* Height-capped and scrolling inside itself: the open panel costs the
          same whether two notes are pinned or ten, so opening it is not a
          decision anyone has to undo to get the thread list back. */}
      <ul className='flex max-h-48 min-w-0 flex-col gap-0.5 overflow-y-auto'>
        {pins.map((pin) =>
          editingId === pin.id ? (
            <li key={pin.id} className='py-1'>
              <GroupChatPinForm
                text={draft}
                onTextChange={setDraft}
                onSubmit={() => void submitEdit(pin.id)}
                onCancel={cancel}
                mode='edit'
                submitting={pending}
                error={error}
              />
            </li>
          ) : (
            <li key={pin.id} className='flex min-w-0 items-start gap-1'>
              <button
                type='button'
                onClick={() => beginEdit(pin)}
                aria-label={`Edit pinned note: ${pin.text}`}
                className='-ml-1.5 flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring'
              >
                {/* Notes wrap in full rather than truncating: a pin exists to
                    be read, and a half-read reminder is not one. Line breaks
                    the author typed are kept. */}
                <span className='min-w-0 flex-1 whitespace-pre-wrap wrap-break-word'>{pin.text}</span>
                <Pencil className='mt-0.5 size-3 shrink-0 text-muted-foreground' aria-hidden='true' />
              </button>
              {/* Separated from the text on purpose: the text is pressed to
                  edit and this is pressed to destroy, so they do not share an
                  edge. Never hover-revealed -- it would not exist on touch. */}
              <button
                type='button'
                onClick={() => onUnpin(pin.id)}
                aria-label={`Unpin note: ${pin.text}`}
                disabled={pending}
                className='mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
              >
                <X className='size-3.5' />
              </button>
            </li>
          ),
        )}
      </ul>

      {composing ? (
        <GroupChatPinForm
          text={draft}
          onTextChange={setDraft}
          onSubmit={() => void submitAdd()}
          onCancel={pins.length > 0 ? cancel : undefined}
          mode='create'
          submitting={pending}
          error={editingId === null ? error : undefined}
          className='pt-1'
        />
      ) : (
        <div className='flex min-w-0 flex-col'>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='-ml-1.5 w-fit'
            disabled={atCap || pending}
            onClick={beginAdd}
          >
            <Plus /> Pin a note
          </Button>
          {/* Why the add is inert, in words, always visible -- a disabled
              control with the reason on a tooltip is a dead end on a touch
              device. It names the way out (unpin one) rather than only
              stating the rule. */}
          {atCap ? <p className='min-w-0 px-1.5 text-xs wrap-break-word text-muted-foreground'>{capMessage}</p> : null}
          {error && editingId === null ? (
            <p role='alert' className='px-1.5 pt-1 text-xs text-destructive'>
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
