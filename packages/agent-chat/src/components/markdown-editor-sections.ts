import type { Editor } from '@tiptap/core'
import { Fragment as ProseMirrorFragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { type EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'

import { type MarkdownGridLayout, markdownGridBlockCount } from './markdown-grid-layouts'
import { insertWithParts } from './markdown-editor-block-inserts'
import { DIRECTIVE_NODES, gridLayoutOf } from './markdown-editor-directives'

/*
 * Sections, as the toolbar's Sections menu offers them: a grid of blocks in
 * one of the grid's layouts. The one menu both inserts a section and changes
 * the layout of the section the caret is in.
 */

/** The innermost grid holding the selection's start, with where it starts. */
function gridAround(state: EditorState): { pos: number; node: ProseMirrorNode } | undefined {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === DIRECTIVE_NODES.grid) {
      return { pos: $from.before(depth), node }
    }
  }
  return undefined
}

/** The layout of the section the selection is in; undefined outside one. */
export function sectionLayoutAt(state: EditorState): MarkdownGridLayout | undefined {
  const grid = gridAround(state)
  return grid ? gridLayoutOf(grid.node) : undefined
}

function isEmptyColumn(column: ProseMirrorNode): boolean {
  return column.childCount === 1 && column.firstChild?.type.name === 'paragraph' && column.firstChild.content.size === 0
}

/**
 * Gives the grid at `pos` `layout`. Columns it gains are empty and go at the
 * end. Columns it loses go from the end, and what they held moves to the end
 * of the last column it keeps, so changing a layout never loses text.
 */
function relayout(tr: Transaction, pos: number, grid: ProseMirrorNode, layout: MarkdownGridLayout) {
  const count = markdownGridBlockCount(layout)
  const { schema } = grid.type
  const end = pos + grid.nodeSize - 1
  if (count > grid.childCount) {
    const added = Array.from({ length: count - grid.childCount }, () =>
      schema.nodes[DIRECTIVE_NODES.column].create(null, schema.nodes.paragraph.create()),
    )
    tr.insert(end, added)
  } else if (count < grid.childCount) {
    // Where the first column to go starts, which is where the last one kept ends.
    let cut = pos + 1
    for (let k = 0; k < count; k++) {
      cut += grid.child(k).nodeSize
    }
    let moved = ProseMirrorFragment.empty
    for (let k = count; k < grid.childCount; k++) {
      if (!isEmptyColumn(grid.child(k))) {
        moved = moved.append(grid.child(k).content)
      }
    }
    const caretDropped = tr.selection.from >= cut
    tr.delete(cut, end)
    const kept = grid.child(count - 1)
    if (moved.size > 0 && isEmptyColumn(kept)) {
      tr.replaceWith(cut - 1 - kept.content.size, cut - 1, moved)
    } else if (moved.size > 0) {
      tr.insert(cut - 1, moved)
    }
    // A caret in a dropped column would map to the gap after the last column
    // kept, outside any text; it goes where that column's content went.
    if (caretDropped) {
      const lastKeptEnd = pos + (tr.doc.nodeAt(pos)?.nodeSize ?? 0) - 2
      tr.setSelection(TextSelection.near(tr.doc.resolve(lastKeptEnd), -1))
    }
  }
  tr.setNodeMarkup(pos, undefined, { ...grid.attrs, layout })
}

/**
 * Gives the section the selection is in `layout`; outside one, inserts a
 * section of `layout` with an empty block for each of its shares, the caret in
 * the first.
 */
export function chooseSectionLayout(editor: Editor, layout: MarkdownGridLayout): boolean {
  const grid = gridAround(editor.state)
  const chain = editor.chain().focus()
  if (grid) {
    return chain
      .command(({ tr }) => {
        relayout(tr, grid.pos, grid.node, layout)
        return true
      })
      .run()
  }
  const column = { type: DIRECTIVE_NODES.column, content: [{ type: 'paragraph' }] }
  const columns = Array.from({ length: markdownGridBlockCount(layout) }, () => column)
  return insertWithParts(chain, { type: DIRECTIVE_NODES.grid, attrs: { layout }, content: columns }).run()
}
