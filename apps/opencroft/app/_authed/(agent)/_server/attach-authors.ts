import { decodeBatch } from 'agent-client/queue-tags'
import type { ChatEvent } from 'agent-client/types'

import type { AuthoredChatEvent } from '@/app/_authed/(agent)/_lib/acp-stream'
import { authorsByIdentifier } from '@/app/_server/account-directory'

/**
 * Attach the accounts a delivered turn was stamped by, on its way to a reader.
 *
 * The one place this happens. Every route that hands chat events to the
 * browser goes through here, so a message carries the same resolution whether
 * it arrived live, in the opening replay, or in a page of older history — and
 * the alternative, resolving in whichever route happened to be handling the
 * request, is how three routes come to disagree about who somebody is.
 *
 * Two kinds carry authors, and they are the two a reader sees a sender on: a
 * delivered turn, and the queue of messages waiting to be delivered. An
 * agent's own replies are already attributed by the session they belong to.
 *
 * The queue is included because it is the SAME message a few seconds earlier.
 * Resolving only the delivered half would make a waiting message show a bare
 * handle and then acquire a face the moment it was handed over, which is one
 * message drawing two ways.
 */
export async function withAuthors(event: ChatEvent): Promise<AuthoredChatEvent> {
  const identifiers = identifiersIn(event)
  if (identifiers.length === 0) {
    return event
  }
  const authors = await authorsByIdentifier(identifiers)
  // Absent rather than empty when nothing resolved: a turn written before
  // accounts had handles should look, on the wire, exactly as it did before
  // this field existed.
  return Object.keys(authors).length > 0 ? { ...event, authors } : event
}

/**
 * The senders an event names, read out of the event itself.
 *
 * A delivered turn is decoded, because one delivery is not one person's words
 * and the header resolves per message rather than per turn. A queue snapshot
 * already holds its messages apart, so its senders are read off directly.
 */
function identifiersIn(event: ChatEvent): string[] {
  if (event.kind === 'user') {
    return decodeBatch(event.text).flatMap((message) => (message.sender ? [message.sender] : []))
  }
  if (event.kind === 'queue') {
    return event.items.flatMap((item) => (item.kind === 'message' && item.sender ? [item.sender] : []))
  }
  return []
}
