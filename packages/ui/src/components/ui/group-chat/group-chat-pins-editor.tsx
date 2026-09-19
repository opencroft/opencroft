'use client'

import { Check, Pencil, Plus, X } from 'lucide-react'
import { useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from 'ui/components/ui/input-group'
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from 'ui/components/ui/item'
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

// The standing notes pinned to a group chat, as a list of items with a field
// under it.
//
// Built from the kit's own pieces and nothing else: each note is an Item (its
// text, a pencil, an X), a note being edited is an InputGroup with its save
// button in the addon, and the last row is always the InputGroup that adds one
// to the end -- type, Enter (or the plus). No form, no dialog, no spacing of
// this component's own: the primitives' insets are the layout.
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

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      {pins.length > 0 ? (
        // Height-capped and scrolling inside itself: the open panel costs the
        // same whether two notes are pinned or ten.
        <ItemGroup className='max-h-56 gap-1 overflow-y-auto'>
          {pins.map((pin) =>
            editingId === pin.id ? (
              <InputGroup key={pin.id}>
                <InputGroupInput
                  autoFocus
                  value={draft}
                  disabled={pending}
                  aria-label='Edit pinned note'
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void saveEdit(pin)
                    } else if (event.key === 'Escape') {
                      cancelEdit()
                    }
                  }}
                />
                <InputGroupAddon align='inline-end'>
                  <InputGroupButton size='icon-xs' aria-label='Save note' disabled={pending} onClick={() => void saveEdit(pin)}>
                    <Check />
                  </InputGroupButton>
                  <InputGroupButton size='icon-xs' aria-label='Cancel' disabled={pending} onClick={cancelEdit}>
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            ) : (
              <Item key={pin.id} size='sm' variant='outline'>
                <ItemContent>
                  {/* Notes wrap in full rather than truncating: a pin exists to
                      be read, and a half-read reminder is not one. */}
                  <ItemTitle className='whitespace-pre-wrap font-normal wrap-break-word'>{pin.text}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon-xs'
                    aria-label={`Edit pinned note: ${pin.text}`}
                    disabled={pending}
                    onClick={() => beginEdit(pin)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon-xs'
                    aria-label={`Unpin note: ${pin.text}`}
                    disabled={pending}
                    onClick={() => onUnpin(pin.id)}
                  >
                    <X />
                  </Button>
                </ItemActions>
              </Item>
            ),
          )}
        </ItemGroup>
      ) : null}

      <InputGroup>
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
