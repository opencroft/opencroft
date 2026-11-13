import type { Editor } from '@tiptap/react'
import {
  Bold,
  Code as CodeIcon,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  type LucideIcon,
  MessageSquareText,
  Minus,
  Quote,
  Redo2,
  RemoveFormatting,
  SquareCode,
  Strikethrough,
  Undo2,
  Unlink,
} from 'lucide-react'

import { editHint, hintTarget } from './markdown-editor-hint'
import { editLink } from './markdown-editor-link'

/*
 * What the editor's controls do, as data: the toolbar's buttons and the
 * field's menus read these lists, so the two always offer the same actions
 * with the same names.
 */

export interface EditorAction {
  id: string
  label: string
  icon: LucideIcon
  run: (editor: Editor) => void
  /** Whether the selection already has it: a toggle's state. A plain action has none. */
  active?: (editor: Editor) => boolean
  /** Whether it can act on the selection; always, when absent. */
  enabled?: (editor: Editor) => boolean
}

/** The toolbar groups made of buttons, each with its actions in order. */
export type ButtonGroup = 'history' | 'marks' | 'headings' | 'blocks' | 'links'

const heading = (level: 1 | 2 | 3, icon: LucideIcon): EditorAction => ({
  id: `h${level}`,
  label: `Heading ${level}`,
  icon,
  run: (editor) => editor.chain().focus().toggleHeading({ level }).run(),
  active: (editor) => editor.isActive('heading', { level }),
})

export const EDITOR_ACTIONS: Record<ButtonGroup, EditorAction[]> = {
  history: [
    {
      id: 'undo',
      label: 'Undo',
      icon: Undo2,
      run: (editor) => editor.chain().focus().undo().run(),
      enabled: (editor) => editor.can().undo(),
    },
    {
      id: 'redo',
      label: 'Redo',
      icon: Redo2,
      run: (editor) => editor.chain().focus().redo().run(),
      enabled: (editor) => editor.can().redo(),
    },
  ],
  marks: [
    {
      id: 'bold',
      label: 'Bold',
      icon: Bold,
      run: (editor) => editor.chain().focus().toggleBold().run(),
      active: (editor) => editor.isActive('bold'),
    },
    {
      id: 'italic',
      label: 'Italic',
      icon: Italic,
      run: (editor) => editor.chain().focus().toggleItalic().run(),
      active: (editor) => editor.isActive('italic'),
    },
    {
      id: 'strike',
      label: 'Strikethrough',
      icon: Strikethrough,
      run: (editor) => editor.chain().focus().toggleStrike().run(),
      active: (editor) => editor.isActive('strike'),
    },
    {
      id: 'code',
      label: 'Inline code',
      icon: CodeIcon,
      run: (editor) => editor.chain().focus().toggleCode().run(),
      active: (editor) => editor.isActive('code'),
    },
    {
      id: 'clear',
      label: 'Clear formatting',
      icon: RemoveFormatting,
      run: (editor) => editor.chain().focus().unsetAllMarks().clearNodes().run(),
    },
  ],
  headings: [heading(1, Heading1), heading(2, Heading2), heading(3, Heading3)],
  blocks: [
    {
      id: 'bullet',
      label: 'Bullet list',
      icon: List,
      run: (editor) => editor.chain().focus().toggleBulletList().run(),
      active: (editor) => editor.isActive('bulletList'),
    },
    {
      id: 'ordered',
      label: 'Numbered list',
      icon: ListOrdered,
      run: (editor) => editor.chain().focus().toggleOrderedList().run(),
      active: (editor) => editor.isActive('orderedList'),
    },
    {
      id: 'quote',
      label: 'Blockquote',
      icon: Quote,
      run: (editor) => editor.chain().focus().toggleBlockquote().run(),
      active: (editor) => editor.isActive('blockquote'),
    },
    {
      id: 'codeblock',
      label: 'Code block',
      icon: SquareCode,
      run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
      active: (editor) => editor.isActive('codeBlock'),
    },
    {
      id: 'rule',
      label: 'Horizontal rule',
      icon: Minus,
      run: (editor) => editor.chain().focus().setHorizontalRule().run(),
    },
  ],
  links: [
    {
      id: 'link',
      label: 'Link',
      icon: LinkIcon,
      run: (editor) => editLink(editor),
      active: (editor) => editor.isActive('link'),
    },
    {
      id: 'unlink',
      label: 'Remove link',
      icon: Unlink,
      run: (editor) => editor.chain().focus().unsetLink().run(),
      enabled: (editor) => editor.isActive('link'),
    },
    {
      id: 'hint',
      label: 'Hint',
      icon: MessageSquareText,
      run: (editor) => editHint(editor),
      // An icon's hint is no mark, so `isActive` misses it.
      active: (editor) => hintTarget(editor.state)?.existing === true,
      enabled: (editor) => hintTarget(editor.state) !== null,
    },
  ],
}

/** An action's state for the current selection. */
export interface EditorActionState {
  active: boolean
  enabled: boolean
}

/**
 * The state of each of `actions`, by id. For a `useEditorState` selector: TipTap 3's
 * `useEditor` does not re-render on every transaction, so a control reading
 * `active` straight from the editor would stop following the caret.
 */
export function actionStates(editor: Editor, actions: EditorAction[]): Record<string, EditorActionState> {
  const states: Record<string, EditorActionState> = {}
  for (const action of actions) {
    states[action.id] = { active: action.active?.(editor) ?? false, enabled: action.enabled?.(editor) ?? true }
  }
  return states
}
