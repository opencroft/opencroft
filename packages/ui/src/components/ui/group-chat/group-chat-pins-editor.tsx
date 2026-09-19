'use client'

import { X } from 'lucide-react'
import { useState } from 'react'

import { Input } from 'ui/components/ui/input'
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
   * into the agents' context -- and spent VISIBLY: at the cap the add field
   * goes inert and says why, rather than letting the press travel and come
   * back refused. */
  max?: number
  /** Pin a new note with this text. The field clears once the promise
   * settles; a rejection keeps the text and is the host's to report through
   * `error`. */
  onAdd: (text: string) => void | Promise<void>
  /** Save an edited note. Same contract as `onAdd`. */
  onEdit: (id: string, text: string) => void | Promise<void>
  /** Unpin one. This DESTROYS the note -- there is no unpinned-notes shelf to
   * recover it from -- so a host that wants a confirmation puts one here. */
  onUnpin: (id: string) => void
  /** A write in flight: the fields go inert. */
  pending?: boolean
  /** A failure to show: a refused pin, an unpin that did not land. */
  error?: string
  capMessage?: string
  className?: string
}

// The standing notes pinned to a group chat, as lines of text.
//
// Each note is a line: press it and the line is a field -- Enter saves, Escape
// puts the note back. The last line is always the empty field that adds one:
// type, Enter, and the note joins the end of the list. No buttons, no form, no
// dialog -- a note is a sentence of standing guidance, and the editor is the
// size of one.
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
  const [draft, setDraft] = useState('')
  const [next, setNext] = useState('')
  const atCap = pins.length >= max

  const beginEdit = (pin: GroupChatPin) => {
    setEditingId(pin.id)
    setDraft(pin.text)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setDraft('')
  }
  const saveEdit = async (pin: GroupChatPin) => {
    const text = draft.trim()
    if (!text || text === pin.text) {
      cancelEdit()
      return
    }
    await onEdit(pin.id, text)
    cancelEdit()
  }
  const add = async () => {
    const text = next.trim()
    if (!text) {
      return
    }
    await onAdd(text)
    setNext('')
  }

  const field = 'h-7 border-0 bg-transparent px-1.5 text-xs shadow-none focus-visible:ring-1'

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      {/* Height-capped and scrolling inside itself: the open panel costs the
          same whether two notes are pinned or ten. */}
      <ul className='flex max-h-48 min-w-0 flex-col overflow-y-auto'>
        {pins.map((pin) => (
          <li key={pin.id} className='flex min-w-0 items-center gap-1'>
            {editingId === pin.id ? (
              <Input
                autoFocus
                value={draft}
                disabled={pending}
                aria-label='Edit pinned note'
                className={cn(field, '-ml-1.5 flex-1')}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void saveEdit(pin)
                  } else if (event.key === 'Escape') {
                    cancelEdit()
                  }
                }}
                onBlur={() => void saveEdit(pin)}
              />
            ) : (
              <button
                type='button'
                onClick={() => beginEdit(pin)}
                aria-label={`Edit pinned note: ${pin.text}`}
                className='-ml-1.5 min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring'
              >
                {pin.text}
              </button>
            )}
            {/* Never hover-revealed -- it would not exist on touch. */}
            <button
              type='button'
              onClick={() => onUnpin(pin.id)}
              aria-label={`Unpin note: ${pin.text}`}
              disabled={pending}
              className='inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
            >
              <X className='size-3.5' />
            </button>
          </li>
        ))}
        <li className='flex min-w-0 items-center gap-1'>
          <Input
            value={next}
            disabled={pending || atCap}
            aria-label='Pin a note'
            placeholder={atCap ? capMessage : 'Pin a note…'}
            className={cn(field, '-ml-1.5 flex-1')}
            onChange={(event) => setNext(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void add()
              }
            }}
          />
          {/* Keeps the field's right edge on the X column above it. */}
          <span aria-hidden className='size-6 shrink-0' />
        </li>
      </ul>
      {error ? (
        <p role='alert' className='px-0 pt-1 text-xs text-destructive'>
          {error}
        </p>
      ) : null}
    </div>
  )
}
