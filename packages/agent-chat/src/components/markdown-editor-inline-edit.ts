import { type Editor, Extension, posToDOMRect } from '@tiptap/core'
import { type EditorState, Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useEditorState } from '@tiptap/react'
import { useState } from 'react'

import { positionMapping } from './markdown-doc-change'

/*
 * The inline content a popover is editing -- a link, and whatever else is
 * added to text the same way. Opening one records which kind and where; the
 * place is mapped through every change after that, one brought from another
 * editor of a shared document included (by what it changed, see
 * `./markdown-doc-change`), so applying acts on the text that was picked even
 * if the document moved under it. The text is painted while it is being
 * edited, and a box around it is what the popover is placed against.
 */

/** What is being edited and where. */
export interface InlineEditTarget {
  /** Which popover owns it: `'link'`, … */
  kind: string
  from: number
  to: number
  /** What the popover's fields start with, as its kind defines them. */
  values: Readonly<Record<string, string>>
  /** Whether the content already carries what is edited, so it can be removed. */
  existing: boolean
}

interface InlineEditState {
  target: InlineEditTarget | null
  /** Counts openings, so a popover can tell a new target from the same one moved. */
  openings: number
}

type InlineEditMeta = { open: InlineEditTarget } | { close: true }

const inlineEditKey = new PluginKey<InlineEditState>('markdownInlineEdit')

function mapTarget(target: InlineEditTarget, tr: Transaction, state: EditorState): InlineEditTarget {
  const mapping = positionMapping(tr, state)
  // Text typed at either edge is outside what was picked.
  const from = mapping.map(target.from, 1)
  const to = Math.max(from, mapping.map(target.to, -1))
  return { ...target, from, to }
}

export const InlineEdit = Extension.create({
  name: 'markdownInlineEdit',
  addProseMirrorPlugins() {
    return [
      new Plugin<InlineEditState>({
        key: inlineEditKey,
        state: {
          init: () => ({ target: null, openings: 0 }),
          apply: (tr, current, oldState) => {
            const meta = tr.getMeta(inlineEditKey) as InlineEditMeta | undefined
            if (meta && 'open' in meta) {
              return { target: meta.open, openings: current.openings + 1 }
            }
            if (meta) {
              return { ...current, target: null }
            }
            if (current.target && tr.docChanged) {
              return { ...current, target: mapTarget(current.target, tr, oldState) }
            }
            return current
          },
        },
        props: {
          decorations: (state) => {
            const target = inlineEditKey.getState(state)?.target
            if (!target || target.from === target.to) {
              return null
            }
            return DecorationSet.create(state.doc, [
              Decoration.inline(target.from, target.to, { class: 'markdown-editor-inline-target' }),
            ])
          },
        },
      }),
    ]
  },
})

/** The open target, if a popover is editing one. */
export function inlineEditTarget(state: EditorState): InlineEditTarget | null {
  return inlineEditKey.getState(state)?.target ?? null
}

/** How many targets have been opened; changes with each new one. */
export function inlineEditOpenings(state: EditorState): number {
  return inlineEditKey.getState(state)?.openings ?? 0
}

/** Starts editing `target` in `tr`, replacing any target already open. */
export function openInlineEdit(tr: Transaction, target: InlineEditTarget): Transaction {
  return tr.setMeta(inlineEditKey, { open: target } satisfies InlineEditMeta)
}

/** Ends editing in `tr`, so a change applied in the same transaction closes it too. */
export function closeInlineEdit(tr: Transaction): Transaction {
  return tr.setMeta(inlineEditKey, { close: true } satisfies InlineEditMeta)
}

/**
 * Ends editing because the reader pressed or moved somewhere else, leaving
 * the selection where that put it.
 *
 * A press in the text closes the popover after the browser has moved the
 * caret but before ProseMirror has read it: that waits for `selectionchange`.
 * Closing takes the highlight off, which redraws the text and writes the
 * editor's selection back to the page, so a close that left the selection
 * alone would put the caret back on the edited text. The DOM's selection is
 * taken first wherever it is inside the editor and differs.
 */
export function dismissInlineEdit(editor: Editor) {
  const { view, state } = editor
  const tr = closeInlineEdit(state.tr)
  const dom = view.dom.ownerDocument.getSelection()
  if (dom?.anchorNode && dom.focusNode && view.dom.contains(dom.anchorNode) && view.dom.contains(dom.focusNode)) {
    try {
      const anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset)
      const head = view.posAtDOM(dom.focusNode, dom.focusOffset)
      if (anchor !== state.selection.anchor || head !== state.selection.head) {
        tr.setSelection(TextSelection.create(tr.doc, anchor, head))
      }
    } catch {
      // A DOM position the editor's view does not map (inside a node view's
      // own controls): the selection stays as ProseMirror has it.
    }
  }
  view.dispatch(tr)
}

/**
 * Closes the popover with the document as it was. With `returnFocus`, the
 * selection is back in the text as it was; without, focus and the caret stay
 * wherever the reader pressed or moved to.
 */
export function cancelInlineEdit(editor: Editor, returnFocus = true) {
  if (!returnFocus) {
    dismissInlineEdit(editor)
    return
  }
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      closeInlineEdit(tr)
      return true
    })
    .run()
}

/**
 * The box around the open target, read each time it is asked for, so a
 * popover placed against it follows the text as it scrolls or moves. A caret
 * is a box of no width.
 */
export function inlineEditAnchor(editor: Editor) {
  // After closing, the popover still asks while it animates out: it gets the
  // box the text last had.
  let last = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  return {
    contextElement: editor.view.dom,
    getBoundingClientRect: () => {
      const target = editor.isDestroyed ? null : inlineEditTarget(editor.state)
      if (target) {
        last = posToDOMRect(editor.view, target.from, target.to)
      }
      return last
    },
  }
}

/**
 * What a popover of `kind` shows: whether it is open, the target it edits --
 * the last one opened, kept while the popover animates out -- the box it is
 * placed against, and a key that changes with each opening, so one target
 * replacing another without a close in between starts from the new one's
 * fields.
 */
export function useInlineEdit(editor: Editor, kind: string) {
  const [anchor] = useState(() => inlineEditAnchor(editor))
  const { target, openings } = useEditorState({
    editor,
    selector: ({ editor }) => ({
      target: inlineEditTarget(editor.state),
      openings: inlineEditOpenings(editor.state),
    }),
  })
  const current = target?.kind === kind ? target : null
  // Its values are the same object for as long as one opening lasts.
  const [last, setLast] = useState<InlineEditTarget | null>(null)
  if (current && current.values !== last?.values) {
    setLast(current)
  }
  return { open: current !== null, target: current ?? last, anchor, key: openings }
}
