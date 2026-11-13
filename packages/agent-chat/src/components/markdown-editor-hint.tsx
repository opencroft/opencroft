'use client'

import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model'
import { type EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'

import { MarkdownHintPopover } from './markdown-hint-popover'
import { HINT_ATTRIBUTE, HINT_MARK, hintText, takesHintAttribute } from './markdown-editor-hint-mark'
import {
  cancelInlineEdit,
  closeInlineEdit,
  type InlineEditTarget,
  inlineEditTarget,
  openInlineEdit,
  useInlineEdit,
} from './markdown-editor-inline-edit'

/*
 * Adding and editing a hint, the way a link is: the toolbar's Hint button
 * opens a popover above the selection with the hint's note. With the
 * selection inside a hint, it edits that hint, whole; otherwise it puts a new
 * one over the selection, whatever inline content that holds.
 */

const HINT = 'hint'

/** The note of the hint over `node`, from its mark or, on an icon, its attribute; null with none. */
function nodeHint(node: ProseMirrorNode): string | null {
  if (takesHintAttribute(node.type.name)) {
    return (node.attrs[HINT_ATTRIBUTE] as string | null) ?? null
  }
  const mark = node.isText ? node.marks.find((each) => each.type.name === HINT_MARK) : undefined
  return (mark?.attrs.text as string | undefined) ?? null
}

interface HintRun {
  from: number
  to: number
  text: string
}

/** The runs of neighbours under one hint -- the same note -- in the textblock that holds `$pos`. */
function hintRuns($pos: ResolvedPos): HintRun[] {
  const runs: HintRun[] = []
  const start = $pos.start()
  $pos.parent.forEach((child, offset) => {
    const text = nodeHint(child)
    const from = start + offset
    const last = runs.at(-1)
    if (text !== null && last?.text === text && last.to === from) {
      last.to = from + child.nodeSize
    } else if (text !== null) {
      runs.push({ from, to: from + child.nodeSize, text })
    }
  })
  return runs
}

/**
 * What the popover would edit for the current selection, or null when there
 * is nothing to put a hint on. A caret at a hint's edge is in it, and a caret
 * between two hints is in the one after it.
 */
export function hintTarget(state: EditorState): InlineEditTarget | null {
  const { from, to, $from } = state.selection
  const around = $from.parent.inlineContent
    ? hintRuns($from).filter((run) => run.from <= from && to <= run.to)
    : []
  const hint = around.find((run) => from < run.to) ?? around[0]
  if (hint) {
    return { kind: HINT, from: hint.from, to: hint.to, values: { text: hint.text }, existing: true }
  }
  return from < to ? { kind: HINT, from, to, values: { text: '' }, existing: false } : null
}

/**
 * Sets the hint over `from`-`to` to `text`, or takes it off with null: the
 * mark on the text there, the attribute on an icon or image.
 */
function setHint(tr: Transaction, from: number, to: number, text: string | null) {
  const type = tr.doc.type.schema.marks[HINT_MARK]
  tr.removeMark(from, to, type)
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (takesHintAttribute(node.type.name)) {
      tr.setNodeAttribute(pos, HINT_ATTRIBUTE, text)
    } else if (node.isText && text !== null) {
      tr.addMark(Math.max(pos, from), Math.min(pos + node.nodeSize, to), type.create({ text }))
    }
  })
}

/** Opens the hint popover for the current selection; `false` when there is nothing to put a hint on. */
export function editHint(editor: Editor): boolean {
  const target = editor.isEditable ? hintTarget(editor.state) : null
  if (!target) {
    return false
  }
  return editor.commands.command(({ tr }) => {
    openInlineEdit(tr, target)
    return true
  })
}

/**
 * Puts the open hint, with `text` as its note, over its content, replacing
 * any hint there. The caret ends after it. `false`, and nothing written, for
 * a note with nothing but whitespace.
 */
export function applyHint(editor: Editor, text: string): boolean {
  const target = inlineEditTarget(editor.state)
  const note = hintText(text)
  if (target?.kind !== HINT || note === '') {
    return false
  }
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      setHint(tr, target.from, target.to, note)
      tr.setSelection(TextSelection.create(tr.doc, target.to))
      closeInlineEdit(tr)
      return true
    })
    .run()
}

/** Takes the open hint off its content, which stays; the caret ends after it. */
export function removeHint(editor: Editor): boolean {
  const target = inlineEditTarget(editor.state)
  if (target?.kind !== HINT) {
    return false
  }
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      setHint(tr, target.from, target.to, null)
      tr.setSelection(TextSelection.create(tr.doc, target.to))
      closeInlineEdit(tr)
      return true
    })
    .run()
}

/** The hint popover, while a hint is being edited. */
export function HintPopover({ editor }: { editor: Editor }) {
  const { open, target, anchor, key } = useInlineEdit(editor, HINT)
  return (
    <MarkdownHintPopover
      key={key}
      open={open}
      anchor={anchor}
      text={target?.values.text ?? ''}
      onApply={(text) => applyHint(editor, text)}
      onCancel={(returnFocus) => cancelInlineEdit(editor, returnFocus)}
      onRemove={target?.existing ? () => removeHint(editor) : undefined}
    />
  )
}
