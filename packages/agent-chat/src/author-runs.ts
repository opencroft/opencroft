import type { ChatUserMessagePart } from './components/chat-turn'

/**
 * Which messages in a sequence begin a new author, and so show a face.
 *
 * A face is drawn when a message's author differs from the message
 * IMMEDIATELY above it, and never otherwise. That is the whole rule, and the
 * two things it is not are what make it worth stating:
 *
 * - Not one face per turn. A turn can carry messages from several senders, and
 *   collapsing them behind one face says three people are one.
 * - Not one face per message. A run by the same sender is one voice speaking,
 *   and repeating the face on every line is noise that hides the moment the
 *   voice actually changes.
 *
 * The comparison is against the previous message only, never against anything
 * seen earlier: a sender who spoke, was interrupted by somebody else, and
 * speaks again starts a NEW run and shows their face again. `a a b a` draws
 * three faces, and the last one is the case a "have we seen this author?"
 * implementation gets wrong.
 *
 * COMPARED BY ACCOUNT, NOT BY DISPLAYED NAME. The identifier a message was
 * stamped with is unique to one account and survives a rename; a display name
 * is free text that two accounts can share, so grouping by it would silently
 * fold two senders into one run and draw one of them wearing the other's face.
 * That is the same argument that keeps display names out of the stamp in the
 * first place, arriving somewhere else.
 *
 * A message with no author at all — an application's own prompt — begins no
 * run and ends none: it has no face to draw, and it must not break a run
 * around it either, because nobody spoke.
 */
export function facesInRun(parts: readonly ChatUserMessagePart[]): boolean[] {
  let previousAuthor: string | undefined
  return parts.map((part) => {
    if (!part.author) {
      // Nobody said this, so it draws no face and leaves the run as it found
      // it -- the sender before it and the sender after it are still adjacent
      // as far as a reader is concerned.
      return false
    }
    const startsRun = part.author !== previousAuthor
    previousAuthor = part.author
    return startsRun
  })
}
