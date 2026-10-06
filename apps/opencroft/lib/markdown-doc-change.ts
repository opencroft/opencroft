import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

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
