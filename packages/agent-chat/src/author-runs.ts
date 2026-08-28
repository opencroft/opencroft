import type { ChatAuthorAccount, ChatUserMessagePart } from './components/chat-turn'

/**
 * One run of consecutive messages by a single sender, and the face it is drawn
 * under.
 *
 * A face belongs to a RUN and not to a message. That is the whole rule, and the
 * two things it is not are what make it worth stating:
 *
 * - Not one face per turn. A turn can carry messages from several senders, and
 *   collapsing them behind one face says three people are one.
 * - Not one face per message. A run by the same sender is one voice speaking,
 *   and repeating the face on every line is noise that hides the moment the
 *   voice actually changes.
 *
 * WHY A RUN IS RETURNED AND NOT A FLAG PER MESSAGE. Both describe the same
 * grouping; only one of them can be drawn. A face has to sit beside the whole
 * run to be shared by it -- to hold the top edge while the rest of the run
 * scrolls under it, and to leave no gap where the messages below it are. A flag
 * per message can only mark the message that opens the run, which puts the face
 * on that one message and leaves every message after it holding an avatar-sized
 * blank: a column of holes rather than one face.
 */
export interface AuthorRun {
  // The messages of this run, in the order they were sent. Never empty.
  parts: readonly ChatUserMessagePart[]
  // Who the run's opening message resolved to, where it resolved to anybody.
  // Absent for a sender the application could not place and for a run nobody
  // sent -- and a run with no account draws no face at all, rather than a
  // stand-in for one.
  account?: ChatAuthorAccount
}

/**
 * Cut a sequence of messages into runs of one sender.
 *
 * A run ends where the sender changes, and the comparison is against the
 * previous message only, never against anything seen earlier: a sender who
 * spoke, was interrupted by somebody else, and speaks again opens a NEW run.
 * `a a b a` is three runs, and the last one is the case a "have we seen this
 * author?" implementation folds back into the first.
 *
 * COMPARED BY ACCOUNT, NOT BY DISPLAYED NAME. The identifier a message was
 * stamped with is unique to one account and survives a rename; a display name
 * is free text that two accounts can share, so grouping by it would silently
 * fold two senders into one run and draw one of them wearing the other's face.
 * That is the same argument that keeps display names out of the stamp in the
 * first place, arriving somewhere else.
 *
 * A message with no author at all -- an application's own prompt -- continues
 * whatever run it lands in and closes none: it has no face to draw, and it must
 * not break a run around it either, because nobody spoke.
 *
 * Arriving FIRST it has no run to continue, so it opens one of its own, and the
 * sender who follows it opens another. That is deliberate rather than a gap in
 * the rule: absorbing the first real sender into the run an unauthored message
 * opened would take that run's account from the message NOBODY sent, and the
 * run would render with no face at all.
 *
 * No memory between calls. A turn is a delivery, and a delivery opens with its
 * sender's face whatever was said before it.
 */
export function authorRuns(parts: readonly ChatUserMessagePart[]): AuthorRun[] {
  const runs: { parts: ChatUserMessagePart[]; account?: ChatAuthorAccount }[] = []
  let previousAuthor: string | undefined
  for (const part of parts) {
    const open = runs[runs.length - 1]
    if (open && (!part.author || part.author === previousAuthor)) {
      open.parts.push(part)
    } else {
      runs.push({ parts: [part], account: part.authorAccount })
    }
    if (part.author) {
      // Only a message somebody sent moves the comparison on. An unauthored one
      // leaves it where it was, so the sender before it and the sender after it
      // are still adjacent as far as a reader is concerned.
      previousAuthor = part.author
    }
  }
  return runs
}
