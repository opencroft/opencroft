import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { type Mappable, StepMap } from '@tiptap/pm/transform'

/*
 * What a change to a markdown document changed. A change made in an editor
 * says so in its steps; one brought from another editor of a shared document
 * does not: the document's binding (TipTap's `Collaboration`) applies it as
 * one step replacing the whole document, and mapping a position through that
 * step sends it to the document's end. The documents before and after are
 * compared instead.
 */

/**
 * Where two versions of a markdown document differ: from `from`, the
 * `[from, endBefore)` of `before` became the `[from, endAfter)` of `after`.
 * Null when they do not differ.
 *
 * The server announces a change by this range and an editor finds what the
 * change replaced in its own copy by it, so both read it from here.
 */
export interface ChangedRange {
  from: number
  endBefore: number
  endAfter: number
}

export function changedRange(before: ProseMirrorNode, after: ProseMirrorNode): ChangedRange | null {
  const from = before.content.findDiffStart(after.content)
  const end = before.content.findDiffEnd(after.content)
  if (from === null || end === null) {
    return null
  }
  // An insertion repeating its neighbour makes the ends overlap the start.
  const overlap = Math.max(0, from - Math.min(end.a, end.b))
  return { from, endBefore: end.a + overlap, endAfter: end.b + overlap }
}

/** How positions move through the change `range`: by what it changed. */
export function changeMapping(range: ChangedRange): Mappable {
  return new StepMap([range.from, range.endBefore - range.from, range.endAfter - range.from])
}

/**
 * Whether the shared document's binding brought `tr` from another editor;
 * `state` is one the binding's plugin belongs to.
 *
 * The binding's plugin is found by its key's name rather than imported, so
 * an editor without one needs no Yjs.
 */
export function fromElsewhere(tr: Transaction, state: EditorState): boolean {
  return state.plugins.some((plugin) => {
    const key = (plugin as unknown as { key: string }).key
    return key.startsWith('y-sync$') && Boolean((tr.getMeta(key) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin)
  })
}

/** How `tr`, applied to `state`, moves positions in its document. */
export function positionMapping(tr: Transaction, state: EditorState): Mappable {
  if (!fromElsewhere(tr, state)) {
    return tr.mapping
  }
  const range = changedRange(tr.before, tr.doc)
  return range ? changeMapping(range) : StepMap.empty
}
