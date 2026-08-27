import { decodeBatch } from 'agent-client/queue-tags'
import type { ChatEvent } from 'agent-client/types'

import type { AuthoredChatEvent, ResolvedAuthor } from '@/app/_authed/(agent)/_lib/acp-stream'
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
  let authors: Record<string, ResolvedAuthor>
  try {
    authors = await authorsByIdentifier(identifiers)
  } catch (err) {
    // A LOOKUP THAT FAILS MUST NOT COST THE MESSAGE. Resolution reads the
    // database and walks the space graph, and either can fail for reasons that
    // have nothing to do with this turn -- so letting it reject would put the
    // message's existence at the mercy of a directory being reachable.
    //
    // Degrading here rather than at each caller is what keeps the paths
    // identical: rejecting would fail a whole history page loudly and drop one
    // live frame silently, which is two behaviours for one cause, in the one
    // module that exists so the paths cannot differ.
    //
    // The state it degrades to is one the header already draws: the message
    // renders with the text it holds and no face, exactly as for a handle no
    // account holds. Logged, because unresolvable-right-now and
    // nobody-holds-this-handle look identical on screen and only one of them
    // is a fault.
    console.error(
      '[chat authors] Could not resolve message authors; the turn is sent unauthored:',
      err instanceof Error ? err.message : String(err),
    )
    return event
  }
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
