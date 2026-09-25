import type { EditablePart } from './user-parts'

/**
 * The per-message drafts of a turn open for editing, keyed by each message's
 * position in the delivered turn.
 *
 * Pure, and kept apart from the composer hook that holds them, so the rules
 * about what a reset restores and what a commit sends can be tested without
 * mounting that hook.
 */
export type EditDrafts = Map<number, string>

/** Every message as it was delivered: an edit's opening state, and what a
 *  reset puts back -- all of it, not only the message on screen. */
export function originalDrafts(parts: readonly EditablePart[]): EditDrafts {
  return new Map(parts.map((part) => [part.index, part.text]))
}

/**
 * Whether any message other than `open` still has words.
 *
 * An emptied message is removed on commit rather than sent empty, so this is
 * what decides whether an empty composer may still commit: yes while another
 * message has something to send, no once every one of them is empty.
 */
export function othersHaveText(
  parts: readonly EditablePart[],
  drafts: EditDrafts,
  open: EditablePart | undefined,
): boolean {
  return parts.some((part) => part !== open && (drafts.get(part.index) ?? part.text).trim() !== '')
}

/**
 * What a commit sends: the messages whose words changed, each with its
 * position. Unchanged messages are left out -- what did not change is not an
 * edit, and the host re-sends the stored message for every position it is not
 * given. An emptied message goes as empty words, which the host reads as
 * "remove this message".
 */
export function changedEdits(parts: readonly EditablePart[], drafts: EditDrafts): { index: number; text: string }[] {
  return parts
    .filter((part) => (drafts.get(part.index) ?? part.text) !== part.text)
    .map((part) => ({ index: part.index, text: drafts.get(part.index) ?? part.text }))
}
