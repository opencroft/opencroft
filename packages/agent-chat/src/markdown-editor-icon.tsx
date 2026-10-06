'use client'

import { type ChainedCommands, type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { IconPicker } from 'ui/components/ui/input/icon-picker'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'

import { MARKDOWN_ICON_COLOR_CHOICES, MarkdownIcon } from './components/markdown-icon'
import { ICON_NODE, IconSchemaNode } from './markdown-editor-icon-node'

/*
 * An icon in the text, as the editor draws and edits it. Its syntax and schema
 * are `./markdown-editor-icon-node`.
 *
 * The icon is one atom that behaves like an emoji character: the caret steps
 * over it in one move and Backspace removes it whole. A click or tap on it --
 * or inserting it -- opens the picker beside it to change the icon or its
 * colour, a theme colour or any of Tailwind's palette, or remove it.
 */

/** What the icon node keeps: the icon whose picker opens next. */
interface IconStorage {
  /** Where `insertIcon` just put an icon, which opens its picker once its view exists. */
  openAt?: number
}

function iconStorage(editor: NodeViewProps['editor']): IconStorage {
  return (editor.storage as unknown as Record<string, IconStorage>)[ICON_NODE]
}

/**
 * The icon as the browser's own text handling sees it, under the drawing. A
 * browser passes over an uneditable element where it treats an emoji as a word
 * of its own, and paints no selection on it. So the icon carries an emoji,
 * too small to draw, where moving by word (Ctrl or Alt with an arrow) stops,
 * then a blank as wide as the icon, which a selection paints like any text.
 * The emoji comes first: a caret the browser leaves at its start reads as
 * before the icon, and anywhere else inside it as after.
 */
function IconText() {
  return (
    <span aria-hidden className='text-transparent'>
      <span className='text-[0px]'>{'\u{1F600}'}</span>
      <span className='tracking-[0.1em]'>&emsp;</span>
    </span>
  )
}

function IconView({ node, editor, getPos, deleteNode }: NodeViewProps) {
  const name = node.attrs.name as string
  const color = (node.attrs.color as string | null) ?? undefined
  // The picker is the icon's own, opened by a click or tap on it -- never by
  // the caret, which steps past the icon like a character.
  const [open, setOpen] = useState(false)
  // An icon `insertIcon` just put in opens its picker, a frame later: the
  // insert focuses the editor, a frame later when it did not have focus
  // (TipTap's own delay), and the picker has to come after that to keep focus
  // in its search. Animation frames run in the order they were asked for.
  useEffect(() => {
    const storage = iconStorage(editor)
    if (storage.openAt === undefined || storage.openAt !== getPos()) {
      return
    }
    const frame = requestAnimationFrame(() => {
      storage.openAt = undefined
      setOpen(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [editor, getPos])
  // Attribute by attribute rather than TipTap's `updateAttributes`, which
  // rewrites a leaf node by replacing it, and with it this view and its open
  // picker. Setting an attribute keeps the node.
  const setAttributes = (attributes: Record<string, unknown>) => {
    const pos = getPos()
    if (typeof pos === 'number') {
      editor
        .chain()
        .command(({ tr }) => {
          for (const [key, value] of Object.entries(attributes)) {
            tr.setNodeAttribute(pos, key, value)
          }
          return true
        })
        .run()
    }
  }
  return (
    <NodeViewWrapper as='span' className='cursor-pointer'>
      <Popover
        open={open && editor.isEditable}
        onOpenChange={(next, { reason }) => {
          setOpen(next)
          // Escape goes back to writing, just after the icon. Any other way
          // out leaves the caret alone: a press in the text has put it where
          // it landed, and a press elsewhere took focus where it went.
          const pos = getPos()
          if (!next && reason === 'escape-key' && typeof pos === 'number') {
            editor
              .chain()
              .focus()
              .setTextSelection(pos + node.nodeSize)
              .run()
          }
        }}
      >
        <PopoverTrigger nativeButton={false} render={<span />} aria-label={`Icon: ${name}`}>
          <IconText />
          <MarkdownIcon name={name} color={color} className='-ml-[1.1em]' />
        </PopoverTrigger>
        {/* No focus return on close: the trigger is the icon inside the
            uneditable node view, and focus left there drops every key typed
            next. Escape puts it in the text instead. */}
        <PopoverContent align='start' finalFocus={false} className='w-[min(20rem,calc(100vw-2rem))]'>
          <IconPicker
            value={name}
            onChange={(next) => setAttributes({ name: next })}
            colors={MARKDOWN_ICON_COLOR_CHOICES}
            palette
            color={color}
            onColorChange={(next) => setAttributes({ color: next ?? null })}
            onRemove={() => {
              deleteNode()
              editor.commands.focus()
            }}
          />
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  )
}

export const IconNode = IconSchemaNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(IconView)
  },
  // The caret against an icon, handled here rather than left to the browser:
  // around an uneditable inline element some browsers take two presses to
  // pass it or lose the caret, where an emoji is always one move and one
  // Backspace. Shift+arrow is left alone, so a selection takes the icon in
  // like a character.
  addKeyboardShortcuts() {
    const icon = this.name
    const nextTo = (direction: 1 | -1) => {
      const { selection } = this.editor.state
      if (!selection.empty) {
        return undefined
      }
      const node = direction > 0 ? selection.$from.nodeAfter : selection.$from.nodeBefore
      return node?.type.name === icon ? { at: selection.from, size: node.nodeSize } : undefined
    }
    const step = (direction: 1 | -1) => () => {
      const next = nextTo(direction)
      return next ? this.editor.commands.setTextSelection(next.at + direction * next.size) : false
    }
    const remove = (direction: 1 | -1) => () => {
      const next = nextTo(direction)
      if (!next) {
        return false
      }
      const from = direction > 0 ? next.at : next.at - next.size
      return this.editor.commands.deleteRange({ from, to: from + next.size })
    }
    return { ArrowRight: step(1), ArrowLeft: step(-1), Delete: remove(1), Backspace: remove(-1) }
  },
  addStorage(): IconStorage {
    return { openAt: undefined }
  },
})

/** The icon a new insert starts as; the picker it opens with is where it is chosen. */
const NEW_ICON = 'smile'

/** Insert an icon at the selection, the caret just after it, and open its picker. */
export function insertIcon(chain: ChainedCommands): ChainedCommands {
  return chain.insertContent({ type: ICON_NODE, attrs: { name: NEW_ICON } }).command(({ tr, editor, dispatch }) => {
    // Only a real insert marks the icon: `can()` runs this without dispatching.
    if (dispatch) {
      // Insertion leaves the caret just after what it inserted.
      iconStorage(editor).openAt = tr.selection.from - 1
    }
    return true
  })
}
