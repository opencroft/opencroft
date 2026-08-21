import { decodeBatch } from 'agent-client/queue-tags'

import type { ChatUserMessagePart, UserText } from './components/chat-turn'

/**
 * Read a delivered prompt back into the messages it was built from.
 *
 * One delivery can carry several messages — a reader can send more while the
 * agent is busy, and they are handed over together as one turn — so a turn's
 * text is not necessarily one person's words at one time. Text that was never
 * encoded that way decodes to a single part with no author and no send time,
 * which is how every message written before the format existed still renders.
 *
 * It lives beside neither block builder because both need it and neither owns
 * it: the app builds blocks through its own prompt pipeline, the package builds
 * them for a host that has none, and duplicating this between them is how the
 * two would come to disagree about what a turn contains.
 *
 * `render` is the host's own last step from a raw message to the words a reader
 * sees — an application that wraps prompts in something of its own strips it
 * here; one that does not passes the text through. Returning null means "no
 * words left", and that message is dropped rather than drawn as an empty
 * bubble. A turn whose messages all return null yields no parts at all, which
 * is the caller's signal that there is nothing to render.
 *
 * The empty-string-to-absent mapping is here and nowhere else. The wire format
 * says "not known" with an empty attribute, because an attribute that is always
 * present is what keeps the parser simple; the UI says it with a missing field,
 * because a blank author would otherwise render as a blank line where a name
 * should be.
 */
export function toUserParts(prompt: string, render: (raw: string) => UserText | null): ChatUserMessagePart[] {
  const parts: ChatUserMessagePart[] = []
  for (const message of decodeBatch(prompt)) {
    const text = render(message.text)
    if (text === null) {
      continue
    }
    parts.push({ text, sender: message.sender || undefined, sentAt: message.sentAt || undefined })
  }
  return parts
}
