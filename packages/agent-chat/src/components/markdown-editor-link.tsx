'use client'

import { type Editor, Extension, getMarkRange } from '@tiptap/core'
import { type EditorState, TextSelection } from '@tiptap/pm/state'

import { MarkdownLinkPopover } from './markdown-link-popover'
import {
  cancelInlineEdit,
  closeInlineEdit,
  type InlineEditTarget,
  inlineEditTarget,
  openInlineEdit,
  useInlineEdit,
} from './markdown-editor-inline-edit'

/*
 * Adding and editing a link: the toolbar's Link button and Mod-K open a
 * popover above the selection with the link's text and address. With the
 * selection inside a link, it edits that link, whole; otherwise it links the
 * selection, or inserts a link at the caret.
 */

const LINK = 'link'

function textOf(state: EditorState, from: number, to: number): string {
  return state.doc.textBetween(from, to, ' ')
}

/** What the popover would edit for the current selection. */
export function linkTarget(state: EditorState): InlineEditTarget {
  const type = state.schema.marks.link
  const { from, to } = state.selection
  const link = getMarkRange(state.doc.resolve(from), type)
  if (link && link.from <= from && to <= link.to) {
    const mark = state.doc.nodeAt(link.from)?.marks.find((each) => each.type === type)
    return {
      kind: LINK,
      from: link.from,
      to: link.to,
      values: { text: textOf(state, link.from, link.to), href: (mark?.attrs.href as string | undefined) ?? '' },
      existing: true,
    }
  }
  return { kind: LINK, from, to, values: { text: textOf(state, from, to), href: '' }, existing: false }
}

/** Opens the link popover for the current selection. */
export function editLink(editor: Editor): boolean {
  if (!editor.isEditable) {
    return false
  }
  return editor.commands.command(({ tr, state }) => {
    openInlineEdit(tr, linkTarget(state))
    return true
  })
}

/**
 * Writes the open link: `href` over its text, which becomes `text` when that
 * differs from what the popover opened with (the address itself when `text`
 * is empty). Text left as it was keeps its formatting and anything inline in
 * it, and what a collaborator has changed in it meanwhile; replaced text takes
 * the formatting its first character had. The caret ends after the link.
 * `false`, and nothing written, when `href` is not an address the link accepts.
 */
export function applyLink(editor: Editor, text: string, href: string): boolean {
  const target = inlineEditTarget(editor.state)
  if (target?.kind !== LINK || !editor.can().setLink({ href })) {
    return false
  }
  const shown = text === '' ? href : text
  return editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      const type = state.schema.marks.link
      const link = type.create({ href })
      const { from, to } = target
      let end = to
      if (from < to && shown === target.values.text) {
        tr.addMark(from, to, link)
      } else {
        const $from = state.doc.resolve(from)
        const marks = (from < to ? state.doc.nodeAt(from)?.marks : undefined) ?? $from.marks()
        tr.replaceWith(from, to, state.schema.text(shown, link.addToSet(type.removeFromSet(marks))))
        end = from + shown.length
      }
      tr.setSelection(TextSelection.create(tr.doc, end))
      tr.setMeta('preventAutolink', true)
      closeInlineEdit(tr)
      return true
    })
    .run()
}

/** Takes the open link off its text, which stays; the caret ends after it. */
export function removeLink(editor: Editor): boolean {
  const target = inlineEditTarget(editor.state)
  if (target?.kind !== LINK) {
    return false
  }
  return editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      tr.removeMark(target.from, target.to, state.schema.marks.link)
      tr.setSelection(TextSelection.create(tr.doc, target.to))
      closeInlineEdit(tr)
      return true
    })
    .run()
}

/** Mod-K opens the link popover, as the toolbar's Link button does. */
export const LinkEditing = Extension.create({
  name: 'markdownLinkEditing',
  addKeyboardShortcuts() {
    return { 'Mod-k': () => editLink(this.editor) }
  },
})

/** The link popover, while a link is being edited. */
export function LinkPopover({ editor }: { editor: Editor }) {
  const { open, target, anchor, key } = useInlineEdit(editor, LINK)
  return (
    <MarkdownLinkPopover
      key={key}
      open={open}
      anchor={anchor}
      text={target?.values.text ?? ''}
      href={target?.values.href ?? ''}
      onApply={(text, href) => applyLink(editor, text, href)}
      onCancel={(returnFocus) => cancelInlineEdit(editor, returnFocus)}
      onRemove={target?.existing ? () => removeLink(editor) : undefined}
    />
  )
}
