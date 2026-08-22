'use client'

import { Button } from 'ui/components/ui/button'
import type { ChatTurnRenderers, ChatUserMessagePart } from './chat-turn'
import { ChatUserMessage } from './chat-turn'

// One message that has arrived but has not been read yet: a message like any
// other, plus the identity the queue knows it by.
//
// It EXTENDS the message rather than restating its fields, so what is waiting
// to be read cannot grow a shape that differs from what is already in the
// transcript -- which is the drift this whole section exists to avoid.
//
// `text` is display-ready: whatever the host encodes on the way to the agent
// has already been undone, because that encoding belongs to the host's protocol
// and not to this section.
export interface ChatUnreadMessage extends ChatUserMessagePart {
  id: string
}

export interface ChatUnreadProps {
  messages: readonly ChatUnreadMessage[]
  // Take one message back before it is delivered. Without it no remove control
  // is offered at all -- this section does not own the queue and cannot take
  // anything out of one on its own.
  onRemove?: (id: string) => void
  // Deliver everything waiting, now, rather than at the cadence. Given, the
  // heading becomes the control for it. Without it the heading is only a
  // heading -- the section cannot hand a queue over by itself.
  onDeliver?: () => void
  renderers: ChatTurnRenderers
}

// The heading: a centred divider across the whole section.
//
// With `onDeliver` the divider is also the deliver-now control. Hover and
// keyboard focus swap the label to what a press does, and the two labels are
// stacked in one grid cell so the wider one reserves the width and the swap
// moves nothing -- a divider that jumped when approached would draw the eye to
// the jump, not to the offer. The resting state is pressable too: hover is an
// affordance, not a route, and a touch user has only the resting label to
// press on. The accessible name says the action rather than either label, so
// what gets announced is stable and says what a press does.
//
// Without `onDeliver` it is a plain divider; a press has nothing to offer.
function UnreadHeading({ onDeliver }: { onDeliver?: () => void }) {
  if (!onDeliver) {
    return (
      <div className='flex w-full items-center gap-2 text-xs font-medium text-muted-foreground'>
        <span className='h-px min-w-6 flex-1 bg-border' />
        <span>Unread Messages</span>
        <span className='h-px min-w-6 flex-1 bg-border' />
      </div>
    )
  }
  return (
    <Button
      type='button'
      variant='ghost'
      className='group h-auto w-full gap-2 px-0 py-1 text-xs font-medium text-muted-foreground'
      aria-label='Deliver every unread message now'
      title='Deliver every unread message now'
      onClick={onDeliver}
    >
      <span className='h-px min-w-6 flex-1 bg-border' />
      {/* Both labels occupy the same grid cell; the wider one sizes it, so the
          swap cannot move the rules. The hidden one is visibility-hidden rather
          than display-none for the same reason -- display-none would not hold
          the cell open for the label it hides. */}
      <span className='grid justify-items-center'>
        <span className='col-start-1 row-start-1 group-hover:invisible group-focus-visible:invisible'>
          Unread Messages
        </span>
        <span className='col-start-1 row-start-1 invisible group-hover:visible group-focus-visible:visible'>
          Push Messages
        </span>
      </span>
      <span className='h-px min-w-6 flex-1 bg-border' />
    </Button>
  )
}

// The messages waiting at the end of a conversation, under a heading that says
// what they are.
//
// **They are the same element the transcript uses, not a summary of one.** How
// long a message waits is a property of the reader rather than of the message,
// and it can be an hour -- so what is waiting is not a transient state worth a
// one-line strip above the composer. It is the part of the conversation that
// has not happened yet, and it is read where the rest of the conversation is
// read, with the same author and the same send time.
//
// It belongs after whatever the host shows for an agent that is working: what
// the agent is doing now comes before what it has not got to yet.
//
// Renders nothing when nothing is waiting, so a host can mount it
// unconditionally instead of repeating the same check at every call site.
export function ChatUnread({ messages, onRemove, onDeliver, renderers }: ChatUnreadProps) {
  if (messages.length === 0) {
    return null
  }
  return (
    <div className='flex min-w-0 w-full flex-col gap-1'>
      <UnreadHeading onDeliver={onDeliver} />
      {messages.map((message) => (
        <ChatUserMessage
          key={message.id}
          // One waiting message is the one-part case of a turn. Passed through
          // whole rather than restated field by field, so a field added to a
          // message cannot be silently dropped on the way here.
          parts={[message]}
          onRemove={onRemove ? () => onRemove(message.id) : undefined}
          renderers={renderers}
        />
      ))}
    </div>
  )
}
