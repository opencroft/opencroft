'use client'

import { Plus, X } from 'lucide-react'
import { useState } from 'react'

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from 'ui/components/ui/input-group'
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
  /** A write in flight: the fields and controls go inert. */
  pending?: boolean
  /** A failure to show: a refused pin, an unpin that did not land. */
  error?: string
  capMessage?: string
  className?: string
}

// The standing notes pinned to a group chat: one field per note, and an empty
// one at the end that adds.
//
// EVERY ROW IS THE SAME ROW -- an InputGroup with one button in its addon --
// so there is no edit mode to enter, nothing grows when a note is touched,
// and the list does not gain a scrollbar because a row changed shape. A note
// is edited by typing in it; Enter or leaving the field saves, Escape puts
// the note back.
//
// The inputs are uncontrolled, keyed on the note's text: a keystroke does not
// travel through the host, and a note changed elsewhere (another member's
// edit, arriving on the next refresh) re-mounts the row with the new text
// rather than sitting stale under an unchanged id.
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
  const [next, setNext] = useState('')
  const atCap = pins.length >= max

  const save = (pin: GroupChatPin, value: string) => {
    const text = value.trim()
    if (text && text !== pin.text) {
      void onEdit(pin.id, text)
    }
  }
  const add = async () => {
    const text = next.trim()
    if (text) {
      await onAdd(text)
      setNext('')
    }
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      {/* Height-capped and scrolling inside itself: the panel costs the same
          whether two notes are pinned or ten.
          THE PADDING IS NOT DECORATION. An InputGroup draws its focus ring
          3px OUTSIDE its border box, so in a scroll container with no inset
          the ring overflows the moment a row is focused and the container
          answers with a scrollbar -- the list jumping as soon as you click
          into a note. The inset gives the ring its room.
          The add field is inside the same container, so every row shares one
          width and one left edge; it is the last line of the list, which is
          also where a new note lands. */}
      <div className='flex max-h-56 min-w-0 flex-col gap-1 overflow-y-auto p-1'>
        {pins.map((pin) => (
          // shrink-0 on every row: an InputGroup is a fixed h-9, and a flex
          // child in a height-capped column shrinks before the column
          // scrolls -- so without this the rows squash as notes are added
          // instead of the list scrolling.
          <InputGroup key={`${pin.id}:${pin.text}`} className='shrink-0'>
            <InputGroupInput
              defaultValue={pin.text}
              disabled={pending}
              aria-label='Pinned note'
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.currentTarget.value = pin.text
                  event.currentTarget.blur()
                }
              }}
              onBlur={(event) => save(pin, event.target.value)}
            />
            <InputGroupAddon align='inline-end'>
              <InputGroupButton
                size='icon-xs'
                aria-label={`Unpin note: ${pin.text}`}
                disabled={pending}
                onClick={() => onUnpin(pin.id)}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        ))}

        <InputGroup className='shrink-0'>
          <InputGroupInput
            value={next}
            disabled={pending || atCap}
            aria-label='Pin a note'
            placeholder='Pin a note…'
            onChange={(event) => setNext(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void add()
              }
            }}
          />
          <InputGroupAddon align='inline-end'>
            <InputGroupButton
              size='icon-xs'
              aria-label='Pin'
              disabled={pending || atCap || next.trim().length === 0}
              onClick={() => void add()}
            >
              <Plus />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>

      {/* Why the add is inert, in words, always visible -- a disabled control
          with the reason on a tooltip is a dead end on a touch device. It
          names the way out (unpin one) rather than only stating the rule. */}
      {atCap ? <p className='text-xs text-muted-foreground'>{capMessage}</p> : null}
      {error ? (
        <p role='alert' className='text-xs text-destructive'>
          {error}
        </p>
      ) : null}
    </div>
  )
}
