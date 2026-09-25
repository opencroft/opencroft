import { decodeBatch, splitDelivery } from 'agent-client/queue-tags'

import type { ChatUserMessagePart, MessageAttachment, UserText } from './components/chat-turn'

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
export function toUserParts(
  prompt: string,
  render: (raw: string) => UserText | null,
  // What each identifier in THIS delivery resolves to, resolved by the host and
  // handed over with the delivery it belongs to.
  //
  // A map rather than a lookup function, and a per-delivery one rather than a
  // directory: this is data that travelled with the item, so a part cannot
  // acquire a different account depending on what the client happened to have
  // loaded when it ran -- the load-dependent rendering the header rule exists
  // to forbid. An identifier that is missing from it is left unresolved, which
  // is a state the header draws, and is what every delivery stamped before
  // accounts had handles falls into.
  //
  // Optional because a host with no notion of accounts has nothing to pass and
  // should not have to say so.
  accounts?: Record<string, { name: string; avatarUrl?: string | null }>,
  // What travelled with each message besides its words, as the host recorded
  // it. Asked with the message's raw text AND its position in the delivery --
  // `index` counts every message the delivery holds, drawn or not -- because a
  // host may keep what travelled beside the text rather than in it, and then
  // the position is the only thing that says which message it came with.
  //
  // A SECOND SEAM rather than a wider `render`, because the two answer different
  // questions: `render` decides what the words are and may decide there are
  // none, which drops the message; this only ever adds to a message that is
  // being drawn anyway. Folding them together would let an attachment reader
  // silently suppress a bubble.
  //
  // Optional, because a host that attaches nothing has nothing to say here --
  // and because every message written before anything did is in exactly that
  // state.
  attachmentsOf?: (raw: string, index: number) => readonly MessageAttachment[],
): ChatUserMessagePart[] {
  const parts: ChatUserMessagePart[] = []
  for (const [index, message] of decodeBatch(prompt).entries()) {
    const attachments = attachmentsOf?.(message.text, index)
    const rendered = render(message.text)
    // A message with no words is dropped -- unless something travelled with
    // it: a picture sent on its own is a message, and its chip is all of it.
    if (rendered === null && !attachments?.length) {
      continue
    }
    const text = rendered ?? ('' as UserText)
    // The wire is unchanged: the tag attribute and the decoded message field
    // are both still `sender`. Only the rendered part renames, because what it
    // holds is the durable identifier rather than a display name.
    const author = message.sender || undefined
    const authorAccount = author ? accounts?.[author] : undefined
    parts.push({
      text,
      author,
      // `satisfies` rather than a bare spread. An optional key spread into a
      // literal is NOT excess-property-checked against the literal's target
      // type, so a misspelled key compiles and the field silently never
      // reaches the component that reads it. The array's element type checks
      // everything else here; it cannot reach inside a spread.
      ...(authorAccount ? ({ authorAccount } satisfies Pick<ChatUserMessagePart, 'authorAccount'>) : {}),
      // Spread on the same terms and for the same reason as the account above:
      // an empty list is absence, not a value, and a part carrying one would
      // make the component draw an empty row where nothing was attached.
      ...(attachments?.length ? ({ attachments } satisfies Pick<ChatUserMessagePart, 'attachments'>) : {}),
      sentAt: message.sentAt || undefined,
    })
  }
  return parts
}

/** One message of a delivered turn, as something a reader can edit. */
export interface EditablePart {
  /**
   * Where this message sits in the DELIVERED turn — not where it sits in this
   * array. The two differ whenever a message renders no words of its own, and
   * a commit is keyed by the delivery's own numbering, because that is the
   * numbering the stored turn is in.
   */
  index: number
  /** The words, as the reader saw them and will edit them. */
  text: string
  /** The pictures this message was delivered with, as the editor opens them. */
  pictures: readonly EditPicture[]
}

/** A picture a delivered message carries, as the editor needs it: the stored
 *  id a commit names it by, and what to draw. `byteSize` is the host's to add
 *  when it knows it. */
export interface EditPicture {
  id: string
  name: string
  src?: string
  byteSize?: number
}

/**
 * Read a delivered turn into the messages a reader can edit, each knowing where
 * it came from.
 *
 * The sibling of `toUserParts`, and deliberately the same shape of thing: same
 * decode, same host `render` seam. It differs in what it carries — positions
 * rather than authors — because editing needs to say WHICH message changed and
 * drawing does not.
 *
 * Two things are not pager stops here, for the same reason: they are not
 * anybody's words. The interrupt note is dropped by the decode (it precedes the
 * first tag, and `splitDelivery` keeps it apart so a commit can put it back
 * untouched). A message that renders nothing — one that was entirely
 * application context — is skipped, and skipping it is exactly why `index`
 * exists: the parts after it keep the numbers the delivery gave them, so an
 * edit still lands on the message it was aimed at.
 *
 * `pictures` are the delivery's own, each marked with the message it came with.
 * A message that renders no words but carried a picture IS a stop: the picture
 * is something the reader can take off it.
 */
export function toEditableParts(
  prompt: string,
  render: (raw: string) => string | null,
  pictures: readonly (EditPicture & { message: number })[] = [],
): EditablePart[] {
  const parts: EditablePart[] = []
  splitDelivery(prompt).messages.forEach((message, index) => {
    const own = pictures.filter((picture) => picture.message === index).map(({ message: _, ...picture }) => picture)
    const text = render(message.text)
    if (text === null && own.length === 0) {
      return
    }
    parts.push({ index, text: text ?? '', pictures: own })
  })
  return parts
}
