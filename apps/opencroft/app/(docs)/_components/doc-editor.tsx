'use client'

import { Button } from 'ui/button'
import { Separator } from 'ui/separator'
import Link from '@tiptap/extension-link'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import { type Editor, EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bold, Check, Code, Heading1, Heading2, Heading3, Italic, Link2, List, ListOrdered, Loader2, SquareCode, TextQuote, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Markdown, type MarkdownStorage } from 'tiptap-markdown'
import { gitDiscardFile, gitPublishDocs, saveDocDirectly } from '@/app/(docs)/_server/actions'
import { cn } from '@/lib/utils'

interface DocEditorProps {
  namespace: string
  filePath: string
  initialContent: string
  onPublish: (content: string) => void
  onDiscard: () => void
}

const SAVE_DEBOUNCE = 500

function readMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as { markdown: MarkdownStorage }
  return storage.markdown.getMarkdown()
}

function promptForLink(editor: Editor) {
  const prev = editor.getAttributes('link').href as string | undefined
  const url = window.prompt('Link URL', prev ?? 'https://')
  if (url === null) {
    return
  }
  if (url === '') {
    editor.chain().focus().unsetLink().run()
    return
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
}

export function DocEditor({ namespace, filePath, initialContent, onPublish, onDiscard }: DocEditorProps) {
  const [busy, setBusy] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({ html: false, linkify: true, breaks: false, transformPastedText: true }),
    ],
    content: initialContent,
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
      timer.current = setTimeout(() => {
        saveDocDirectly({ data: { namespace, filePath, content: readMarkdown(ed) } })
      }, SAVE_DEBOUNCE)
    },
  })

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    },
    [],
  )

  const handlePublish = async () => {
    if (!editor) {
      return
    }
    if (timer.current) {
      clearTimeout(timer.current)
    }
    setBusy(true)
    // Save working tree (already auto-staged by docs.addFile), commit + push
    await saveDocDirectly({ data: { namespace, filePath, content: readMarkdown(editor) } })
    const msg = commitMsg.trim() || `Update ${filePath}`
    await gitPublishDocs({ data: { namespace, filePath, message: msg } })
    setCommitMsg('')
    setBusy(false)
    onPublish(readMarkdown(editor))
  }

  const handleDiscard = async () => {
    if (timer.current) {
      clearTimeout(timer.current)
    }
    setBusy(true)
    await gitDiscardFile({ data: { namespace, filePath } })
    setBusy(false)
    onDiscard()
  }

  if (!editor) {
    return null
  }

  return (
    <div className='flex flex-col h-full min-h-0'>
      <div className='sticky top-0 z-10 bg-background flex items-center gap-0.5 flex-wrap border-b py-2 px-1'>
        <ToolbarButton label='Heading 1' active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 />
        </ToolbarButton>
        <ToolbarButton label='Heading 2' active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 />
        </ToolbarButton>
        <ToolbarButton label='Heading 3' active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
          <Heading3 />
        </ToolbarButton>
        <Separator orientation='vertical' className='mx-1 h-5' />
        <ToolbarButton label='Bold (Ctrl+B)' active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold />
        </ToolbarButton>
        <ToolbarButton label='Italic (Ctrl+I)' active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic />
        </ToolbarButton>
        <ToolbarButton label='Inline code' active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
          <Code />
        </ToolbarButton>
        <ToolbarButton label='Link' active={editor.isActive('link')} onClick={() => promptForLink(editor)}>
          <Link2 />
        </ToolbarButton>
        <Separator orientation='vertical' className='mx-1 h-5' />
        <ToolbarButton label='Bulleted list' active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List />
        </ToolbarButton>
        <ToolbarButton label='Numbered list' active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <ListOrdered />
        </ToolbarButton>
        <ToolbarButton label='Quote' active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          <TextQuote />
        </ToolbarButton>
        <ToolbarButton label='Code block' active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
          <SquareCode />
        </ToolbarButton>
        <div className='flex-1' />
        <input
          type='text'
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder='Commit message...'
          className='h-7 px-2 text-xs border rounded-md bg-transparent max-w-[200px]'
          onKeyDown={(e) => e.stopPropagation()}
        />
        <Button size='sm' variant='outline' onClick={handleDiscard} disabled={busy}>
          <X /> Discard
        </Button>
        <Button size='sm' onClick={handlePublish} disabled={busy}>
          {busy ? <Loader2 className='animate-spin' /> : <Check />} Publish
        </Button>
      </div>
      <EditorContent
        editor={editor}
        className={cn('flex-1 min-h-0 py-4 prose-docs', '[&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[60vh]', '[&_.ProseMirror>*:first-child]:mt-0 [&_.ProseMirror>*:last-child]:mb-0')}
      />
    </div>
  )
}

interface ToolbarButtonProps {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}

function ToolbarButton({ label, active, onClick, children }: ToolbarButtonProps) {
  return (
    <Button size='icon-sm' variant='ghost' title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className={cn(active && 'bg-accent text-accent-foreground')}>
      {children}
    </Button>
  )
}
