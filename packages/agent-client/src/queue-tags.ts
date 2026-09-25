/**
 * The wire format for a delivery: how messages become one prompt, and how that
 * prompt is read back apart again.
 *
 * Encoder and parser live together, in one module, because they are one format.
 * Split across two files they drift: an escape added on one side and not the
 * other is a silent corruption, not a compile error.
 *
 * ## Why the metadata is in the text
 *
 * Sender and send time have to survive a session reload. A reload replays the
 * transcript through ACP as `user_message_chunk` text and nothing else — no turn
 * boundaries, no metadata of its own. Anything carried out of band is gone the
 * moment the page is refreshed, and the transcript would render with the wrong
 * attribution and the wrong time.
 *
 * That is also why **every** message is tagged, including a delivery carrying
 * only one. The tag is not a separator that a single message can do without —
 * it is the only place its author and time exist after a reload.
 *
 * ## The format
 *
 *   <agent-message author="Ada" datetime="2026-03-04T09:12:00.000Z"/>
 *   First message
 *   <agent-message author="Grace" datetime="2026-03-04T09:13:40.000Z"/>
 *   Second message
 *
 * Self-closing, one per line, immediately followed by its message. The tags are
 * the only separators — there is no batch header and no count, because the parts
 * are countable from the tags themselves.
 *
 * The TypeScript field names are `sender` and `sentAt`, matching the queue and
 * the persisted columns; the wire attributes are `author` and `datetime`. That
 * mapping lives here and nowhere else.
 */

/** One message in a delivery, as it went into the queue. */
export interface TaggedMessage {
  /** Who sent it — an agent name, a person's name, whatever the surface knows. */
  sender: string
  /** When it was SENT, not when the delivery happened. The point of the tag. */
  sentAt: string
  text: string
}

// Named for what it IS, not for whichever application is sending it. This
// package is embedded by more than one product, and the moment it ships the tag
// is written into transcripts that are replayed for as long as they exist —
// after that, renaming it means rewriting history nobody owns. The neutral name
// is the cheap version of a decision that stops being cheap on first deploy.
const TAG_NAME = 'agent-message'

// Anchored to the start of a line, so a tag mentioned mid-sentence is never
// mistaken for a real one. `(?:[^"\\]|\\.)*` because an attribute value can
// legitimately contain anything once escaped.
const TAG_LINE = new RegExp(`^<${TAG_NAME} author="((?:[^"\\\\]|\\\\.)*)" datetime="((?:[^"\\\\]|\\\\.)*)"/>$`)

// A line the parser would otherwise read as a tag, with any number of leading
// escapes already on it — matched so escaping is idempotent-safe rather than
// doubling up differently on each pass.
const TAG_LINE_START = new RegExp(`^\\\\*<${TAG_NAME}`, 'gm')
const ESCAPED_TAG_LINE_START = new RegExp(`^\\\\(\\\\*<${TAG_NAME})`, 'gm')

/**
 * Escape an attribute value so it cannot close its own tag.
 *
 * Backslash first, always: escaping quotes before backslashes would turn an
 * input backslash into an escape character for the quote that follows it, and
 * the round trip would silently lose one. This is the ordering bug that makes
 * escaping look correct until someone sends a Windows path.
 */
function escapeAttr(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function unescapeAttr(value: string): string {
  return value.replace(/\\(.)/g, '$1')
}

/**
 * Escape a tag that a message's own text happens to start a line with, so it is
 * not read back as a header.
 *
 * Only line starts are touched, because only line starts are ever parsed as
 * tags — escaping every occurrence would mangle prose that merely mentions the
 * syntax, which the documentation of this format does.
 */
function escapeBody(text: string): string {
  return text.replaceAll(TAG_LINE_START, (match) => `\\${match}`)
}

function unescapeBody(text: string): string {
  return text.replaceAll(ESCAPED_TAG_LINE_START, '$1')
}

/**
 * Encode messages into the body of a delivery. Every message is tagged, with no
 * special case for one: see this module's header for why a lone message needs
 * its tag as much as a batch does.
 */
export function encodeBatch(messages: TaggedMessage[]): string {
  return messages
    .map(
      (m) =>
        `<${TAG_NAME} author="${escapeAttr(m.sender)}" datetime="${escapeAttr(m.sentAt)}"/>\n${escapeBody(m.text)}`,
    )
    .join('\n')
}

/**
 * The note an interrupt-adjacent delivery opens with, addressed to the agent.
 *
 * It lives here, beside the parser, because the parser is what makes it safe:
 * lines before the first tag are dropped when the transcript is read back, so
 * this reaches the agent and never renders as something the reader wrote. Move
 * it away from `decodeBatch` and a later change to either one silently starts
 * showing an internal note as a chat message.
 *
 * The exact wording matters. Deliberately neutral about what the interrupt
 * meant — the agent is to weigh what arrived, not be handed a conclusion about
 * it — and deliberately carries no count, since the tags are countable.
 */
const INTERRUPT_NOTE =
  'Your turn was interrupted to deliver the queued messages below together. ' +
  'This may or may not mean your current work should change. ' +
  'Read all of them — later messages supersede earlier ones — ' +
  "work out the sender's current intent, then continue from what you had already done."

/**
 * The High Attention cadence's version of the same event: a message arrived and
 * was handed over at once, stopping the turn to do it. One line, because under
 * this cadence an interrupt is the ordinary way a message arrives — the reader
 * asked for everything to reach them now — so the four-clause queue-jump note
 * would be repeated at them message after message. Same discipline though:
 * neutral about what the interrupt meant, and it says continue, not start over.
 */
const HIGH_ATTENTION_NOTE =
  'Your turn was interrupted to deliver the incoming messages below. Read them, then continue from what you had.'

/**
 * Which of the two notes a delivery opens with. `'queue-jump'` explains a
 * one-off push past the cadence the reader set; `'interrupt'` explains a stop
 * the cadence itself asked for. Same event either way — a turn was ended to
 * hand something over — which is why they are one field and not two booleans:
 * a delivery that interrupted nothing has no note at all, and one that did has
 * exactly one wording.
 */
export type DeliveryNote = 'queue-jump' | 'interrupt'

const DELIVERY_NOTES: Record<DeliveryNote, string> = {
  'queue-jump': INTERRUPT_NOTE,
  interrupt: HIGH_ATTENTION_NOTE,
}

/**
 * What is being handed to the agent. A caller must say which, and the two are
 * not interchangeable.
 *
 * - `messages` — things somebody sent. Tagged, so their author and time survive
 *   a reload, and noted when the delivery interrupted a turn.
 * - `system` — a prompt the application issues on its own behalf: `/compact`,
 *   the standing-context restore, a thread's opening envelope, a scheduled
 *   digest. **Delivered exactly as given, with nothing in front of it.**
 *
 * The distinction is a union rather than an optional flag on purpose. Tagging is
 * unconditional for messages, so anything that reaches this function without
 * declaring itself gets a tag — and a tag line in front of `/compact` stops it
 * being a slash command at all. That failure is silent, team-wide, and surfaces
 * days later as "compaction stopped working" with nothing pointing here. A
 * caller that forgets to choose must fail to compile, not fall through to the
 * dangerous side of the branch.
 */
export type Delivery =
  | { kind: 'messages'; messages: TaggedMessage[]; note?: DeliveryNote }
  | { kind: 'system'; text: string }

/**
 * Build the single prompt a delivery hands to the agent.
 *
 * For messages, the note fires whenever the delivery interrupted a turn,
 * whatever it is carrying: it answers "why did my turn die?", and a single
 * corrective message is the purest case of the thing it exists for — a reader
 * stopping the agent to redirect it. A delivery that interrupted nothing says
 * nothing, because there is nothing to explain and the tags are the framing.
 *
 * For a system send there is no author, no time and no interrupt to explain, so
 * there is nothing to add and nothing is added.
 */
export function buildDelivery(delivery: Delivery): string {
  if (delivery.kind === 'system') {
    return delivery.text
  }
  if (delivery.messages.length === 0) {
    return ''
  }
  const body = encodeBatch(delivery.messages)
  return delivery.note ? `${DELIVERY_NOTES[delivery.note]}\n\n${body}` : body
}

/**
 * Read a delivered prompt back into its parts.
 *
 * Text with no tags is one untagged message with no author or time. That is not
 * an error path: it is every message written before this format existed, still
 * sitting in transcripts that get replayed. Inventing values for them would be
 * worse than admitting they are not known.
 *
 * Anything that is not a well-formed tag line is body text, including whatever
 * precedes the first tag — which is what keeps the interrupt note out of the
 * reader's transcript. A parser that threw on unrecognised input would turn a
 * message quoting this syntax into a broken transcript, which is the failure the
 * escaping exists to prevent.
 */
export function decodeBatch(prompt: string): TaggedMessage[] {
  const lines = prompt.split('\n')
  const parts: TaggedMessage[] = []
  let current: { sender: string; sentAt: string; body: string[] } | null = null

  for (const line of lines) {
    const match = TAG_LINE.exec(line)
    if (match) {
      if (current) {
        parts.push(finish(current))
      }
      current = { sender: unescapeAttr(match[1]), sentAt: unescapeAttr(match[2]), body: [] }
      continue
    }
    if (current) {
      current.body.push(line)
    }
  }
  if (current) {
    parts.push(finish(current))
  }
  if (parts.length === 0) {
    return [{ sender: '', sentAt: '', text: prompt }]
  }
  return parts
}

function finish(current: { sender: string; sentAt: string; body: string[] }): TaggedMessage {
  return { sender: current.sender, sentAt: current.sentAt, text: unescapeBody(current.body.join('\n')) }
}

/**
 * A delivery taken apart for EDITING, which needs more than reading it does.
 *
 * - `messages` — the parts, exactly as `decodeBatch` reads them.
 * - `prefix` — everything before the first tag, kept verbatim, newline and all.
 * - `tagged` — whether the source carried tags at all.
 *
 * The prefix is why this exists beside `decodeBatch` rather than instead of it.
 * `decodeBatch` DROPS those lines on purpose: they are the interrupt note,
 * addressed to the agent, and a reader must never see them rendered as words
 * somebody wrote. An editor needs the opposite — the note was part of the turn
 * that was delivered, it is nobody's message and nobody's to change, so it has
 * to come back on the other side untouched.
 *
 * `tagged` is the same kind of care for the other end of the format's history.
 * Text written before tags existed decodes to a single part with no author and
 * no time; re-encoding that would write `author="" datetime=""` into a
 * transcript that never had a tag in it, inventing a structure to describe the
 * absence of one. The flag is what lets a rebuild put such a turn back exactly
 * as it found it.
 */
export interface SplitDelivery {
  prefix: string
  messages: TaggedMessage[]
  tagged: boolean
}

export function splitDelivery(prompt: string): SplitDelivery {
  const lines = prompt.split('\n')
  const firstTag = lines.findIndex((line) => TAG_LINE.test(line))
  if (firstTag === -1) {
    return { prefix: '', messages: decodeBatch(prompt), tagged: false }
  }
  // Terminated with the newline that separated it from the first tag, so
  // `prefix + encodeBatch(...)` reproduces the original byte for byte -- the
  // blank line `buildDelivery` puts between the note and the body included.
  const prefix = firstTag === 0 ? '' : `${lines.slice(0, firstTag).join('\n')}\n`
  return { prefix, messages: decodeBatch(prompt), tagged: true }
}

/**
 * Put an edited turn back together: the original's framing and metadata, the
 * caller's words.
 *
 * Every part keeps the author and send time it was delivered with, because
 * those are facts about who spoke and when, and an edit is not a claim about
 * either. They come from `original` — the delivered text the transcript
 * already holds — and never from the caller, which is the whole security
 * property here: the surface that supplies the new words has no way to state
 * whose words they were. A part whose text happens to contain tag syntax is
 * escaped by `encodeBatch` exactly as any other body is, so an edit cannot
 * forge a part either.
 *
 * A count mismatch throws rather than reconciling. There is no honest way to
 * guess which part a missing text belonged to, and the failure it would
 * otherwise produce — words re-attributed to the wrong sender — is exactly the
 * one this function exists to make impossible. Callers hand back what they were
 * given, or nothing.
 *
 * A `null` text REMOVES that message: no body and no tag, as if it had never
 * been in the delivery. The position still has to be stated, for the same
 * reason as above -- a removal is a claim about one particular message, and a
 * shorter array would say nothing about which. Removing every message throws:
 * a turn with no messages is not an edit of that turn, and the interrupt note
 * on its own would be a delivery addressed to nobody.
 */
export function rebuildDelivery(original: string, texts: (string | null)[]): string {
  const { prefix, messages, tagged } = splitDelivery(original)
  if (texts.length !== messages.length) {
    throw new Error(`Edited turn has ${texts.length} parts, the delivered turn has ${messages.length}`)
  }
  const kept = messages.flatMap((message, index) => {
    const text = texts[index]
    return text === null ? [] : [{ ...message, text }]
  })
  if (kept.length === 0) {
    throw new Error('Edited turn removes every message it has')
  }
  // Untagged in, untagged out. There is exactly one part in this case (see
  // `decodeBatch`), and its text is the whole prompt -- so the edit replaces
  // the whole prompt, which is what an untagged turn IS.
  if (!tagged) {
    return kept[0].text
  }
  return prefix + encodeBatch(kept)
}

/**
 * The texts `rebuildDelivery` takes, from a delivered turn and the edits made to
 * it: every message as delivered, except where an edit names its position.
 *
 * An edit whose words are blank REMOVES its message (`null`) rather than
 * leaving an empty one behind. An empty message is not something anybody said,
 * and sent on it would still carry a tag naming its author.
 *
 * `place` puts an edit's words where the message's old text stood. By default
 * the words replace it outright; a host that wraps each message in context of
 * its own passes the function that carries that context over.
 */
export function applyTurnEdits(
  original: string,
  edits: readonly { index: number; text: string }[],
  place: (current: string, words: string) => string = (_current, words) => words,
): (string | null)[] {
  const texts: (string | null)[] = splitDelivery(original).messages.map((message) => message.text)
  for (const edit of edits) {
    const current = texts[edit.index]
    if (current === undefined || current === null) {
      throw new Error(`Edited message ${edit.index} is not in a turn of ${texts.length}`)
    }
    texts[edit.index] = edit.text.trim() === '' ? null : place(current, edit.text)
  }
  return texts
}

/**
 * The attachments of a delivery after `rebuildDelivery` removed some of its
 * messages: a removed message's attachments go with it, and every survivor's
 * position is renumbered to where its message now stands.
 *
 * `texts` is the same array handed to `rebuildDelivery`, so the two cannot
 * disagree about which messages survived.
 */
export function rebuildAttachments<T extends { message: number }>(
  attachments: readonly T[],
  texts: readonly (string | null)[],
): T[] {
  const positions: number[] = []
  let next = 0
  for (const text of texts) {
    positions.push(text === null ? -1 : next++)
  }
  return attachments.flatMap((attachment) => {
    const message = positions[attachment.message] ?? -1
    return message === -1 ? [] : [{ ...attachment, message }]
  })
}
