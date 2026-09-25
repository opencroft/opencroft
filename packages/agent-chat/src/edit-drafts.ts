import type { TurnEdit } from 'agent-client/queue-tags'

import { type ComposerPicture, type PictureSlots, storedIds } from './use-composer-pictures'
import type { EditablePart, EditPicture } from './user-parts'

/**
 * The per-message drafts of a turn open for editing: the words, keyed by each
 * message's position in the delivered turn, and the pictures, one composer
 * slot per message (see `editSlot`).
 *
 * Pure, and kept apart from the composer hook that holds them, so the rules
 * about what a reset restores and what a commit sends can be tested without
 * mounting that hook.
 */
export type EditDrafts = Map<number, string>

/** The composer picture slot holding one edited message's pictures. */
export function editSlot(index: number): string {
  return `${EDIT_SLOT_PREFIX}${index}`
}
export const EDIT_SLOT_PREFIX = 'edit:'

/** Every message's words as delivered: an edit's opening state, and what a
 *  reset puts back -- all of it, not only the message on screen. */
export function originalDrafts(parts: readonly EditablePart[]): EditDrafts {
  return new Map(parts.map((part) => [part.index, part.text]))
}

/** Every message's pictures as delivered, by slot: the same opening state and
 *  reset target as `originalDrafts`, for the other half of a message. */
export function originalPictures(parts: readonly EditablePart[]): Record<string, readonly EditPicture[]> {
  return Object.fromEntries(parts.map((part) => [editSlot(part.index), part.pictures]))
}

/** Whether a message still has something to send. A picture that failed to
 *  attach does not count: it will not travel. */
export function hasContent(text: string, pictures: readonly ComposerPicture[] | undefined): boolean {
  return text.trim() !== '' || (pictures ?? []).some((picture) => !picture.error)
}

/**
 * Whether any message other than `open` still has something to send.
 *
 * A message left with nothing is removed on commit rather than sent empty, so
 * this is what decides whether an empty composer may still commit: yes while
 * another message has words or pictures, no once every one of them is empty.
 */
export function othersHaveContent(
  parts: readonly EditablePart[],
  drafts: EditDrafts,
  slots: PictureSlots,
  open: EditablePart | undefined,
): boolean {
  return parts.some(
    (part) => part !== open && hasContent(drafts.get(part.index) ?? part.text, slots[editSlot(part.index)]),
  )
}

/**
 * What a commit sends: the messages that changed, each with its position.
 *
 * Words are sent when anything about the message changed; `attachments` only
 * when its pictures did, as the complete list of stored ids. Unchanged messages
 * are left out -- what did not change is not an edit, and the host re-sends the
 * stored message for every position it is not given. A message left with
 * neither words nor pictures goes as exactly that, which the host reads as
 * "remove this message".
 *
 * Reads the slots as they stand once uploads have settled: a picture still
 * uploading has no id to send.
 */
export function changedEdits(
  parts: readonly EditablePart[],
  drafts: EditDrafts,
  slots: PictureSlots,
): TurnEdit<string>[] {
  return parts.flatMap((part) => {
    const text = drafts.get(part.index) ?? part.text
    const ids = storedIds(slots[editSlot(part.index)])
    const picturesChanged = ids.length !== part.pictures.length || ids.some((id, at) => id !== part.pictures[at].id)
    if (text === part.text && !picturesChanged) {
      return []
    }
    return [{ index: part.index, text, ...(picturesChanged ? { attachments: ids } : {}) }]
  })
}
