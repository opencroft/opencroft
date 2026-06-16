'use client'

import Link from '@tiptap/extension-link'
import { type Editor, EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  Bold,
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
  Undo2,
  Unlink,
} from 'lucide-react'
import { useEffect } from 'react'
import { Markdown } from 'tiptap-markdown'
import { Button } from 'ui/components/ui/button'
import { Flex } from 'ui/components/ui/layout/flex'
import { Separator } from 'ui/components/ui/separator'
import { cn } from 'ui/lib/utils'

export interface SkillEditorProps {
  // Markdown source (the skill body). Edited visually; stored as markdown.
  value: string
  onChange: (markdown: string) => void
  className?: string
}

// Prose styling for the editable content. The `prose` plugin over-spaces list
// items and leaves code unstyled, so we tighten lists and put inline + block
// code on a secondary background (arbitrary variants outrank prose's :where()).
const CONTENT_CLASS = [
  'prose prose-invert max-w-none min-h-full p-3 focus:outline-none',
  '[&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_li_p]:my-0',
  '[&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-normal [&_code]:text-secondary-foreground [&_code]:before:content-none [&_code]:after:content-none',
  '[&_pre]:bg-secondary [&_pre]:text-secondary-foreground [&_pre_code]:px-0 [&_pre_code]:py-0',
].join(' ')

// A markdown WYSIWYG editor for an agent skill's instruction body. Controlled —
// pass the markdown `value` and persist on `onChange`.
export function SkillEditor({ value, onChange, className }: SkillEditorProps) {
  const editor = useEditor({
    // Defer rendering to the client to avoid SSR hydration mismatches.
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      // Read/write markdown. `html: true` keeps any legacy HTML content readable
      // while it migrates to markdown on the next save.
      Markdown.configure({ html: true, transformPastedText: true, transformCopiedText: false }),
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.storage.markdown.getMarkdown()),
    editorProps: {
      attributes: {
        class: CONTENT_CLASS,
      },
    },
  })

  // Load a different skill's markdown into the editor without emitting onChange.
  useEffect(() => {
    if (editor && !editor.isDestroyed && value !== editor.storage.markdown.getMarkdown()) {
      editor.commands.setContent(value, false)
    }
  }, [value, editor])

  if (!editor) {
    return <div className={cn('rounded-md border bg-background', className)} />
  }

  return (
    <Flex className={cn('rounded-md border bg-background min-h-0', className)}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className='flex-1 min-h-0 overflow-y-auto' />
    </Flex>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Link URL', previous ?? 'https://')
    if (url === null) return
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  return (
    <Flex row align='center' className='border-b p-1 gap-0.5 flex-wrap'>
      <TB onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title='Undo'>
        <Undo2 />
      </TB>
      <TB onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title='Redo'>
        <Redo2 />
      </TB>
      <Sep />
      <TB active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title='Bold'>
        <Bold />
      </TB>
      <TB active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title='Italic'>
        <Italic />
      </TB>
      <TB
        active={editor.isActive('strike')}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title='Strikethrough'
      >
        <Strikethrough />
      </TB>
      <TB
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
        title='Inline code'
      >
        <Code />
      </TB>
      <Sep />
      <TB
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        title='Heading 1'
      >
        <Heading1 />
      </TB>
      <TB
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title='Heading 2'
      >
        <Heading2 />
      </TB>
      <TB
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        title='Heading 3'
      >
        <Heading3 />
      </TB>
      <Sep />
      <TB
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title='Bullet list'
      >
        <List />
      </TB>
      <TB
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title='Numbered list'
      >
        <ListOrdered />
      </TB>
      <TB
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title='Blockquote'
      >
        <Quote />
      </TB>
      <TB
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        title='Code block'
      >
        <SquareCode />
      </TB>
      <Sep />
      <TB active={editor.isActive('link')} onClick={setLink} title='Link'>
        <LinkIcon />
      </TB>
      <TB
        onClick={() => editor.chain().focus().unsetLink().run()}
        disabled={!editor.isActive('link')}
        title='Remove link'
      >
        <Unlink />
      </TB>
      <TB onClick={() => editor.chain().focus().setHorizontalRule().run()} title='Horizontal rule'>
        <Minus />
      </TB>
      <Sep />
      <TB onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} title='Clear formatting'>
        <RemoveFormatting />
      </TB>
    </Flex>
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
  children: React.ReactNode
}) {
  return (
    <Button
      type='button'
      size='icon-sm'
      variant={active ? 'secondary' : 'ghost'}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {children}
    </Button>
  )
}
