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
 * Only `user` events carry authors: they are the only ones holding a delivered
 * batch, and an agent's own replies are already attributed by the session they
 * belong to.
 */
export async function withAuthors(event: ChatEvent): Promise<AuthoredChatEvent> {
  if (event.kind !== 'user') {
    return event
  }
  // The senders this delivery actually names, read out of the delivery itself
  // rather than out of anything about the session. A turn can carry messages
  // from several people, which is the whole reason the header needs resolving
  // per message rather than per turn.
  const identifiers = decodeBatch(event.text).flatMap((message) => (message.sender ? [message.sender] : []))
  if (identifiers.length === 0) {
    return event
  }
  const authors = await authorsByIdentifier(identifiers)
  // Absent rather than empty when nothing resolved: a turn written before
  // accounts had handles should look, on the wire, exactly as it did before
  // this field existed.
  return Object.keys(authors).length > 0 ? { ...event, authors } : event
}
