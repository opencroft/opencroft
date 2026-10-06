import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { type Mappable, StepMap } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

import type { ChangedRange } from '@/lib/markdown-doc-change'

/*
 * What a change from elsewhere replaced, as this editor drew it.
 *
 * Such a change reaches the editor as one transaction replacing the whole
 * document, so its steps do not say what changed; the documents before and
 * after are compared instead (`changedRange`), as the server compares them
 * when it announces the change. The replaced content is copied from the
 * editor's own DOM while the change is being applied -- the last moment it is
 * still drawn -- so a playback can show it exactly as the reader saw it,
 * formatting, blocks and node views included.
 */

export interface ReplacedContent {
  /** The change's range in the document after it, as the server announces it. */
  announced: { from: number; to: number }
  /** What a playback covers in that document: the change itself, or the whole blocks it reaches into. */
  from: number
  to: number
  /** Copies of the nodes that drew the replaced content; none for an insertion. */
  nodes: Node[]
  /** Whether those are whole blocks, which stand between blocks, rather than content in a line. */
  blocks: boolean
}

/** How positions move through a change from elsewhere: by what it changed, not by its whole-document step. */
export function changeMapping(range: ChangedRange): Mappable {
  return new StepMap([range.from, range.endBefore - range.from, range.endAfter - range.from])
}

/**
 * What the change `range` from `before` to `after` replaced, copied from
 * `view` while it still draws `before`. A change within one line keeps to the
 * line; one reaching across blocks covers the whole blocks it touches, before
 * and after, so the replaced blocks are shown whole where the new ones will
 * stand.
 */
export function replacedContent(
  view: EditorView,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  range: ChangedRange,
): ReplacedContent {
  const announced = { from: range.from, to: range.endAfter }
  const $from = before.resolve(range.from)
  const $oldEnd = before.resolve(range.endBefore)
  const $newEnd = after.resolve(range.endAfter)
  // The text before the change is the same in both documents, and so is the
  // text after it: a depth found at either end holds for both.
  const depth = Math.min($from.sharedDepth(range.endBefore), after.resolve(range.from).sharedDepth(range.endAfter))
  if ($from.parent.inlineContent && depth === $from.depth && depth === $oldEnd.depth) {
    const nodes = inlineCopies(view, range.from, range.endBefore)
    return { announced, from: range.from, to: range.endAfter, nodes, blocks: false }
  }
  const from = $from.depth > depth ? $from.before(depth + 1) : range.from
  const oldTo = $oldEnd.depth > depth ? $oldEnd.after(depth + 1) : range.endBefore
  const to = $newEnd.depth > depth ? $newEnd.after(depth + 1) : range.endAfter
  return { announced, from, to, nodes: blockCopies(view, before, from, oldTo), blocks: true }
}

function inlineCopies(view: EditorView, from: number, to: number): Node[] {
  if (to <= from) {
    return []
  }
  const start = view.domAtPos(from)
  const end = view.domAtPos(to)
  const range = view.dom.ownerDocument.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return [...withoutEditorParts(range.cloneContents()).childNodes]
}

/** The blocks of `doc` from `from` to `to`, each as the editor draws it. */
function blockCopies(view: EditorView, doc: ProseMirrorNode, from: number, to: number): Node[] {
  const copies: Node[] = []
  for (let pos = from; pos < to; ) {
    const node = doc.nodeAt(pos)
    if (!node) {
      break
    }
    const dom = view.nodeDOM(pos)
    if (dom instanceof Element) {
      copies.push(withoutEditorParts(dom.cloneNode(true) as Element))
    }
    pos += node.nodeSize
  }
  return copies
}

/** Takes out what the editor draws that is not content: decorations' widgets -- carets, labels -- and line-end fillers. */
function withoutEditorParts<T extends Element | DocumentFragment>(copy: T): T {
  for (const part of copy.querySelectorAll('.ProseMirror-widget, .ProseMirror-trailingBreak')) {
    part.remove()
  }
  return copy
}
