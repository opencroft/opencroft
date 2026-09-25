'use client'

import { type Editor, useEditorState } from '@tiptap/react'
import {
  Blocks,
  Bold,
  ChevronDown,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  RemoveFormatting,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Undo2,
  Unlink,
} from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'
import { Flex } from 'ui/components/ui/layout/flex'
import { Separator } from 'ui/components/ui/separator'
import { cn } from 'ui/lib/utils'

import { BLOCK_INSERTS } from './markdown-editor-block-inserts'

/**
 * Which toolbar controls to offer. The chat composer wants fewer of these than
 * a documentation page does, and a surface that wants none passes `false`.
 *
 * `blockMenu` is the Blocks menu: callouts, spoiler, tabs, table and divider,
 * the same list the `/` menu offers.
 */
export type MarkdownEditorToolbarGroup = 'history' | 'marks' | 'headings' | 'blocks' | 'links' | 'table' | 'blockMenu'

export const ALL_TOOLBAR_GROUPS: MarkdownEditorToolbarGroup[] = [
  'history',
  'marks',
  'headings',
  'blocks',
  'links',
  'table',
  'blockMenu',
]

export function Toolbar({
  editor,
  groups,
  extra,
  className,
}: {
  editor: Editor
  groups: MarkdownEditorToolbarGroup[]
  extra?: ReactNode
  className?: string
}) {
  // TipTap 3's `useEditor` re-renders on create and destroy, not on every
  // transaction. A toolbar reading `editor.isActive(...)` straight through
  // would light its buttons once and then stop following the caret; this is the
  // subscription that makes the active states true.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      heading1: editor.isActive('heading', { level: 1 }),
      heading2: editor.isActive('heading', { level: 2 }),
      heading3: editor.isActive('heading', { level: 3 }),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      blockquote: editor.isActive('blockquote'),
      codeBlock: editor.isActive('codeBlock'),
      link: editor.isActive('link'),
    }),
  })

  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Link URL', previous ?? 'https://')
    if (url === null) {
      return
    }
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  const rendered: ReactNode[] = []
  for (const group of groups) {
    if (rendered.length > 0) {
      rendered.push(<Sep key={`sep-${group}`} />)
    }
    if (group === 'history') {
      rendered.push(
        <TB key='undo' onClick={() => editor.chain().focus().undo().run()} disabled={!state.canUndo} title='Undo'>
          <Undo2 />
        </TB>,
        <TB key='redo' onClick={() => editor.chain().focus().redo().run()} disabled={!state.canRedo} title='Redo'>
          <Redo2 />
        </TB>,
      )
    }
    if (group === 'marks') {
      rendered.push(
        <TB key='bold' active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()} title='Bold'>
          <Bold />
        </TB>,
        <TB
          key='italic'
          active={state.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title='Italic'
        >
          <Italic />
        </TB>,
        <TB
          key='strike'
          active={state.strike}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title='Strikethrough'
        >
          <Strikethrough />
        </TB>,
        <TB
          key='code'
          active={state.code}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title='Inline code'
        >
          <Code />
        </TB>,
        <TB
          key='clear'
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
          title='Clear formatting'
        >
          <RemoveFormatting />
        </TB>,
      )
    }
    if (group === 'headings') {
      rendered.push(
        <TB
          key='h1'
          active={state.heading1}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title='Heading 1'
        >
          <Heading1 />
        </TB>,
        <TB
          key='h2'
          active={state.heading2}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title='Heading 2'
        >
          <Heading2 />
        </TB>,
        <TB
          key='h3'
          active={state.heading3}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          title='Heading 3'
        >
          <Heading3 />
        </TB>,
      )
    }
    if (group === 'blocks') {
      rendered.push(
        <TB
          key='bullet'
          active={state.bulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title='Bullet list'
        >
          <List />
        </TB>,
        <TB
          key='ordered'
          active={state.orderedList}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title='Numbered list'
        >
          <ListOrdered />
        </TB>,
        <TB
          key='quote'
          active={state.blockquote}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title='Blockquote'
        >
          <Quote />
        </TB>,
        <TB
          key='codeblock'
          active={state.codeBlock}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title='Code block'
        >
          <SquareCode />
        </TB>,
        <TB key='rule' onClick={() => editor.chain().focus().setHorizontalRule().run()} title='Horizontal rule'>
          <Minus />
        </TB>,
      )
    }
    if (group === 'links') {
      rendered.push(
        <TB key='link' active={state.link} onClick={setLink} title='Link'>
          <LinkIcon />
        </TB>,
        <TB
          key='unlink'
          onClick={() => editor.chain().focus().unsetLink().run()}
          disabled={!state.link}
          title='Remove link'
        >
          <Unlink />
        </TB>,
      )
    }
    if (group === 'table') {
      rendered.push(
        <TB
          key='table'
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          title='Insert table'
        >
          <TableIcon />
        </TB>,
      )
    }
    if (group === 'blockMenu') {
      rendered.push(<BlockMenu key='blockMenu' editor={editor} />)
    }
  }

  return (
    <Flex row align='center' className={cn('border-b p-1 gap-0.5 flex-wrap', className)}>
      {rendered}
      {extra ? (
        <>
          <div className='flex-1' />
          {extra}
        </>
      ) : null}
    </Flex>
  )
}

/** The Blocks menu: every entry of `BLOCK_INSERTS`, callouts first, then the rest. */
function BlockMenu({ editor }: { editor: Editor }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type='button' size='sm' variant='ghost' title='Insert a block'>
            <Blocks />
            Blocks
            <ChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align='end'>
        {BLOCK_INSERTS.map((item, index) => {
          const Icon = item.icon
          const startsGroup = index > 0 && BLOCK_INSERTS[index - 1].group !== item.group
          return (
            <Fragment key={item.id}>
              {startsGroup ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onClick={() => item.insert(editor.chain().focus()).run()}>
                <Icon />
                {item.label}
              </DropdownMenuItem>
            </Fragment>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Sep() {
  return <Separator orientation='vertical' className='mx-0.5 h-5' />
}

function TB({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean
  disabled?: boolean
  onClick: () => void
  title?: string
  children: ReactNode
}) {
  return (
    <Button
      type='button'
      size='icon-sm'
      variant={active ? 'secondary' : 'ghost'}
      disabled={disabled}
      // The editor keeps the selection the button acts on: without this, the
      // mousedown moves focus out of the editable area first and the command
      // runs against a collapsed selection.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      title={title}
    >
      {children}
    </Button>
  )
}
