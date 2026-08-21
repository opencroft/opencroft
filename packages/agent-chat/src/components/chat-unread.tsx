'use client'

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
  renderers: ChatTurnRenderers
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
export function ChatUnread({ messages, onRemove, renderers }: ChatUnreadProps) {
  if (messages.length === 0) {
    return null
  }
  return (
    <div className='flex min-w-0 w-full flex-col gap-1'>
      <div className='px-1 text-xs font-medium text-muted-foreground'>Unread</div>
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
