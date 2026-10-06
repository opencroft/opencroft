import type { EditorState } from '@tiptap/pm/state'
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap'
import * as Y from 'yjs'

/*
 * Positions as they travel between copies of a shared document. A plain
 * position is an offset into one copy's document, wrong in any other copy the
 * moment either is edited; a relative position names a place in the Yjs
 * document, which every copy resolves to the same place in its own.
 */

/** `pos` in `state`'s document as a relative position, or null before the editor is bound. */
export function relativePosition(state: EditorState, pos: number): Y.RelativePosition | null {
  const sync = ySyncPluginKey.getState(state)
  return sync?.binding ? absolutePositionToRelativePosition(pos, sync.type, sync.binding.mapping) : null
}

/** A relative position, as JSON from another copy, in `state`'s document; null when it is not there. */
export function absolutePosition(state: EditorState, position: unknown): number | null {
  const sync = ySyncPluginKey.getState(state)
  if (!sync?.binding) {
    return null
  }
  return relativePositionToAbsolutePosition(
    sync.doc,
    sync.type,
    Y.createRelativePositionFromJSON(position),
    sync.binding.mapping,
  )
}
