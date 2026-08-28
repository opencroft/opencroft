// Shared envelope composer for every path that delivers a message into an agent
// session (chat UI, send-message/notification pipeline). Isomorphic — no
// server-only imports — so both a client component and a server module can
// import it directly instead of keeping their own copy in sync by hand.
//
// One axis decides what gets prefixed to a message: `sessionInit`, the content
// that defines who the agent is and what job it's doing (task context, standing
// instructions). It is session-scoped, so it must only be attached when
// `isNewSession` is true, regardless of which sender created the session.
// A leading slash marks a command, never a conversational message — passed
// through unwrapped by every sender.

export interface SessionInitContext {
  jobContext?: string
  instructions?: string[]
}

export interface ComposeEnvelopeOptions {
  sessionInit?: SessionInitContext
  isNewSession: boolean
}

export function composeEnvelope(message: string, opts: ComposeEnvelopeOptions): string {
  if (message.trim().startsWith('/')) {
    return message
  }

  const parts: string[] = []

  if (opts.isNewSession && opts.sessionInit) {
    const { jobContext, instructions } = opts.sessionInit
    if (jobContext?.trim()) {
      parts.push(`<opencroft-task>${jobContext.trim()}</opencroft-task>`)
    }
    for (const instr of instructions ?? []) {
      const trimmed = instr.trim()
      if (trimmed) {
        parts.push(`<opencroft-instruction>${trimmed}</opencroft-instruction>`)
      }
    }
  }

  return parts.length ? `${parts.join('\n')}\n${message}` : message
}

/**
 * Prefix a message with the reader's current selection, wrapped in its own
 * envelope tag. The selection travels as context the same way the other
 * `<opencroft-*>` parts do: ahead of the message, stripped from the user
 * bubble by the display side's tag stripper, delivered verbatim to the agent.
 *
 * `content` is what the agent receives — the selection's label is presentation
 * and stays on the screen that showed it. A blank content wraps nothing, and a
 * leading slash marks a command (same rule as composeEnvelope above), passed
 * through untouched.
 */
export function wrapUserSelection(message: string, content: string): string {
  const trimmed = content.trim()
  if (!trimmed || message.trim().startsWith('/')) {
    return message
  }
  return `<opencroft-user-selection>${trimmed}</opencroft-user-selection>\n${message}`
}

// One `<opencroft-*>` block at the very start of a message. Anchored, so a tag
// quoted in the middle of a sentence is a sentence, not machinery.
const LEADING_ENVELOPE_TAG = /^<opencroft-([a-z0-9-]+)>[\s\S]*?<\/opencroft-\1>[^\S\n]*\n?/i

/**
 * Split a delivered message into the context this app attached and the words
 * the reader actually wrote.
 *
 * The inverse of what `composeEnvelope` and `wrapUserSelection` do, and it can
 * be an inverse because both of them PREFIX: every `<opencroft-*>` part goes
 * ahead of the message. The display side already relies on that when it strips
 * them out of the bubble; this relies on it to put them back.
 *
 * Editing is what needs the two halves apart. What a reader edits is their own
 * words — they never saw the context and never typed it — but the context is
 * still true of the message they are re-sending, so it travels unchanged rather
 * than being dropped or regenerated from a canvas they may have moved on from.
 *
 * A tag that somehow sits after the first word is left in `words`, where it
 * reads as text. That matches the one thing this cannot do anything about: the
 * reader was shown the message with such a tag stripped, so it is not in what
 * they hand back, and there is nothing here to splice.
 */
export function splitEnvelope(text: string): { context: string; words: string } {
  let rest = text
  let context = ''
  for (;;) {
    const match = LEADING_ENVELOPE_TAG.exec(rest)
    if (!match) {
      return { context, words: rest }
    }
    context += match[0]
    rest = rest.slice(match[0].length)
  }
}

/**
 * Drop a delivery stamp from the front of an already-delivered turn.
 *
 * Nothing writes one any more, and this is not dead code because of it: a turn
 * delivered before the stamp was removed still carries it in the event log, and
 * editing that turn re-delivers its text. Without this strip it would go back
 * out with a stamp naming the moment it was FIRST received — a lie about the
 * delivery actually happening.
 */
export function stripDeliveryStamp(text: string): string {
  return text.replace(/^<opencroft-time>[\s\S]*?<\/opencroft-time>[^\S\n]*\n?/i, '')
}

// NOTHING PRODUCES A DELIVERY STAMP ANY MORE. It was a `dd.mm.yyyy hh:mm:ss`
// prefix written at the delivery chokepoint, and it went because it was the
// less readable of the two timestamps an agent received: day-first, so 07.08
// could be either month, and zoneless, so its being UTC was inferred from
// agreeing with the other rather than read from the value. Every message
// already carries `datetime` on its own tag, in ISO 8601 with a zone.
//
// The stripper above stays, and is not dead code: turns delivered before the
// removal are in the event log with the stamp still on them, and editing one
// re-delivers its text. Without the strip, an edited old turn would go back
// out with a stamp saying when it was FIRST received, which is a lie about
// the delivery that is actually happening.
