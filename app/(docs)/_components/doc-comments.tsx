'use client'

import { Bot, Loader2, MessageCircle, Send, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listDocComments, postDocComment } from '@/app/(docs)/_server/actions'
import type { Anchor, Comment } from '@/app/(docs)/_server/comments'
import { useSSEEvents } from '@/app/(sse)/_lib/sse-events-store'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface DocCommentsOverlayProps {
  namespace: string
  docPath: string
  /** Changes whenever markdown content re-renders — triggers anchor re-injection. */
  renderKey: string
}

interface SelectionInfo {
  rect: DOMRect
  quote: string
  prefix: string
  suffix: string
}

interface IconPosition {
  id: string
  top: number
}

const MAX_CONTEXT = 40
const SELECTION_DEBOUNCE = 120

function getContentEl(): HTMLElement | null {
  return document.querySelector('.prose-docs')
}

function flatten(nodes: Comment[]): Comment[] {
  const out: Comment[] = []
  for (const c of nodes) {
    out.push(c)
    if (c.replies.length > 0) {
      out.push(...flatten(c.replies))
    }
  }
  return out
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) {
    return 'just now'
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`
  }
  return new Date(ts).toLocaleDateString()
}

function renderMessage(message: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  const regex = /@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = regex.exec(message)) !== null) {
    if (match.index > last) {
      parts.push(message.slice(last, match.index))
    }
    parts.push(
      <span key={`m-${i++}`} className='text-primary font-medium'>
        @{match[1]}
      </span>,
    )
    last = match.index + match[0].length
  }
  if (last < message.length) {
    parts.push(message.slice(last))
  }
  return parts
}

function unwrapAnchors(container: HTMLElement): void {
  const wrapped = container.querySelectorAll('.doc-comment-anchor')
  wrapped.forEach((span) => {
    const parent = span.parentNode
    if (!parent) {
      return
    }
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span)
    }
    parent.removeChild(span)
  })
  container.normalize()
}

function findOccurrenceIndex(text: string, anchor: Anchor): number {
  let idx = 0
  while ((idx = text.indexOf(anchor.quote, idx)) !== -1) {
    const before = text.slice(Math.max(0, idx - MAX_CONTEXT), idx)
    const after = text.slice(idx + anchor.quote.length, idx + anchor.quote.length + MAX_CONTEXT)
    const okPrefix = !anchor.prefix || before.endsWith(anchor.prefix)
    const okSuffix = !anchor.suffix || after.startsWith(anchor.suffix)
    if (okPrefix && okSuffix) {
      return idx
    }
    idx += 1
  }
  // Fall back to first match
  return text.indexOf(anchor.quote)
}

function wrapTextRange(container: HTMLElement, startOffset: number, length: number, commentId: string): HTMLElement | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let consumed = 0
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    const nodeLen = node.data.length
    if (consumed + nodeLen > startOffset) {
      const localStart = startOffset - consumed
      const localEnd = Math.min(nodeLen, localStart + length)
      const range = document.createRange()
      range.setStart(node, localStart)
      range.setEnd(node, localEnd)
      const span = document.createElement('span')
      span.className = 'doc-comment-anchor'
      span.dataset.commentId = commentId
      try {
        range.surroundContents(span)
        return span
      } catch {
        return null
      }
    }
    consumed += nodeLen
  }
  return null
}

export function DocCommentsOverlay({ namespace, docPath, renderKey }: DocCommentsOverlayProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [composerAnchor, setComposerAnchor] = useState<SelectionInfo | null>(null)
  const [message, setMessage] = useState('')
  const [replyMessage, setReplyMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [icons, setIcons] = useState<IconPosition[]>([])
  const [iconsVersion, setIconsVersion] = useState(0)

  const { docCommentsVersion } = useSSEEvents()
  const version = docCommentsVersion.get(docPath) ?? 0

  const reload = useCallback(async () => {
    const next = await listDocComments({ data: { namespace, filePath: docPath } })
    setComments(next)
  }, [namespace, docPath])

  useEffect(() => {
    reload()
  }, [reload, version])

  // Track live selection only when not composing
  useEffect(() => {
    if (composerAnchor) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const handler = () => {
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        const sel = window.getSelection()
        const content = getContentEl()
        if (!sel || sel.isCollapsed || !content) {
          setSelection(null)
          return
        }
        const range = sel.getRangeAt(0)
        if (!content.contains(range.commonAncestorContainer)) {
          setSelection(null)
          return
        }
        const quote = sel.toString().trim()
        if (!quote) {
          setSelection(null)
          return
        }
        const rect = range.getBoundingClientRect()
        const fullText = content.textContent ?? ''
        const idx = fullText.indexOf(quote)
        const prefix = idx > 0 ? fullText.slice(Math.max(0, idx - MAX_CONTEXT), idx) : ''
        const suffix = idx >= 0 ? fullText.slice(idx + quote.length, idx + quote.length + MAX_CONTEXT) : ''
        setSelection({ rect, quote, prefix, suffix })
      }, SELECTION_DEBOUNCE)
    }
    document.addEventListener('selectionchange', handler)
    return () => {
      document.removeEventListener('selectionchange', handler)
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [composerAnchor])

  // Inject anchors + compute icon positions
  useEffect(() => {
    if (!comments) {
      return
    }
    const content = getContentEl()
    const wrapper = wrapperRef.current
    if (!content || !wrapper) {
      return
    }
    unwrapAnchors(content)

    const fullText = content.textContent ?? ''
    const positions: IconPosition[] = []
    for (const c of comments) {
      if (!c.anchor) {
        continue
      }
      const idx = findOccurrenceIndex(fullText, c.anchor)
      if (idx < 0) {
        continue
      }
      const span = wrapTextRange(content, idx, c.anchor.quote.length, c.id)
      if (!span) {
        continue
      }
      const spanRect = span.getBoundingClientRect()
      const wrapperRect = wrapper.getBoundingClientRect()
      positions.push({ id: c.id, top: spanRect.top - wrapperRect.top })
    }
    positions.sort((a, b) => a.top - b.top)
    setIcons(positions)
  }, [comments, renderKey, iconsVersion])

  // Reposition on resize
  useEffect(() => {
    const onResize = () => setIconsVersion((v) => v + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Mark active thread anchor in DOM
  useEffect(() => {
    const content = getContentEl()
    if (!content) {
      return
    }
    content.querySelectorAll<HTMLElement>('.doc-comment-anchor').forEach((el) => {
      if (el.dataset.commentId === openThread) {
        el.dataset.active = 'true'
      } else {
        delete el.dataset.active
      }
    })
  }, [openThread])

  // Open thread when user clicks an anchored span
  useEffect(() => {
    const content = getContentEl()
    if (!content) {
      return
    }
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const span = target?.closest?.('.doc-comment-anchor') as HTMLElement | null
      if (span?.dataset.commentId) {
        setOpenThread(span.dataset.commentId)
      }
    }
    content.addEventListener('click', handler)
    return () => content.removeEventListener('click', handler)
  }, [renderKey, comments])

  const handleAskAI = () => {
    if (!selection) {
      return
    }
    setComposerAnchor(selection)
    setSelection(null)
    setOpenThread(null)
  }

  const handleCancelComposer = () => {
    setComposerAnchor(null)
    setMessage('')
    window.getSelection()?.removeAllRanges()
  }

  const handleSendComposer = async () => {
    if (!composerAnchor || !message.trim()) {
      return
    }
    setBusy(true)
    const anchor: Anchor = {
      quote: composerAnchor.quote,
      ...(composerAnchor.prefix ? { prefix: composerAnchor.prefix } : {}),
      ...(composerAnchor.suffix ? { suffix: composerAnchor.suffix } : {}),
    }
    await postDocComment({ data: { namespace, filePath: docPath, message: message.trim(), parentId: undefined, anchor } })
    setMessage('')
    setComposerAnchor(null)
    setBusy(false)
    window.getSelection()?.removeAllRanges()
    await reload()
  }

  const handleSendReply = async (parentId: string) => {
    if (!replyMessage.trim()) {
      return
    }
    setBusy(true)
    await postDocComment({ data: { namespace, filePath: docPath, message: replyMessage.trim(), parentId } })
    setReplyMessage('')
    setBusy(false)
    await reload()
  }

  const iconsById = new Map(icons.map((i) => [i.id, i]))
  const selectedThread = openThread && comments ? (comments.find((c) => c.id === openThread) ?? null) : null
  const selectedIcon = selectedThread ? iconsById.get(selectedThread.id) : null

  return (
    <div ref={wrapperRef} className='absolute inset-0 pointer-events-none'>
      {icons.map(({ id, top }) => (
        <button
          key={id}
          style={{ top }}
          onClick={() => setOpenThread((o) => (o === id ? null : id))}
          className={cn(
            'pointer-events-auto absolute -right-9 size-6 rounded-full bg-background border shadow-sm',
            'inline-flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-accent transition-colors',
            openThread === id && 'text-primary border-primary',
          )}
          title='Open thread'
          aria-label='Open comment thread'
        >
          <MessageCircle className='size-3.5' />
        </button>
      ))}

      {selectedThread && selectedIcon && (
        <Popover open onOpenChange={(o) => !o && setOpenThread(null)}>
          <PopoverAnchor asChild>
            <div className='absolute pointer-events-none' style={{ top: selectedIcon.top, right: -36, width: 1, height: 24 }} />
          </PopoverAnchor>
          <PopoverContent side='right' align='start' sideOffset={8} className='w-80 pointer-events-auto'>
            <ThreadView
              thread={selectedThread}
              replyMessage={replyMessage}
              setReplyMessage={setReplyMessage}
              onSendReply={() => handleSendReply(selectedThread.id)}
              onClose={() => setOpenThread(null)}
              busy={busy}
            />
          </PopoverContent>
        </Popover>
      )}

      {selection &&
        !composerAnchor &&
        typeof document !== 'undefined' &&
        createPortal(
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleAskAI}
            style={{
              position: 'fixed',
              top: Math.max(8, selection.rect.top - 44),
              left: Math.max(8, selection.rect.left + selection.rect.width / 2 - 50),
              zIndex: 60,
            }}
            className='pointer-events-auto inline-flex items-center gap-1.5 px-3 h-8 rounded-full bg-primary text-primary-foreground text-sm shadow-lg hover:bg-primary/90 transition-colors'
          >
            <Bot className='size-4' /> Ask AI
          </button>,
          document.body,
        )}

      {composerAnchor &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: Math.min(window.innerHeight - 240, composerAnchor.rect.bottom + 10),
              left: Math.max(8, Math.min(window.innerWidth - 376, composerAnchor.rect.left)),
              width: 360,
              zIndex: 60,
            }}
            className='pointer-events-auto bg-background border rounded-lg shadow-xl p-3 flex flex-col gap-2'
          >
            <div className='flex items-start gap-2'>
              <blockquote className='flex-1 text-xs text-muted-foreground border-l-2 border-primary pl-2 line-clamp-3 m-0'>{composerAnchor.quote}</blockquote>
              <button onClick={handleCancelComposer} className='text-muted-foreground hover:text-foreground shrink-0' aria-label='Cancel'>
                <X className='size-4' />
              </button>
            </div>
            <Textarea
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder='Ask AI about this selection… mention @agentname'
              className='min-h-20 text-sm'
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handleSendComposer()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  handleCancelComposer()
                }
              }}
            />
            <div className='flex items-center justify-between'>
              <p className='text-xs text-muted-foreground m-0'>Ctrl+Enter to send</p>
              <Button size='sm' onClick={handleSendComposer} disabled={busy || !message.trim()}>
                {busy ? <Loader2 className='animate-spin' /> : <Send />} Send
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

interface ThreadViewProps {
  thread: Comment
  replyMessage: string
  setReplyMessage: (s: string) => void
  onSendReply: () => void
  onClose: () => void
  busy: boolean
}

function ThreadView({ thread, replyMessage, setReplyMessage, onSendReply, onClose, busy }: ThreadViewProps) {
  const replies = flatten(thread.replies)
  return (
    <div className='flex flex-col gap-3 max-h-[70vh]'>
      <div className='flex items-center justify-between'>
        <span className='text-xs font-semibold uppercase tracking-wider text-muted-foreground'>Thread</span>
        <button onClick={onClose} className='text-muted-foreground hover:text-foreground' aria-label='Close thread'>
          <X className='size-4' />
        </button>
      </div>
      {thread.anchor?.quote && <blockquote className='text-xs text-muted-foreground border-l-2 border-primary pl-2 line-clamp-3 m-0'>{thread.anchor.quote}</blockquote>}
      <div className='flex flex-col gap-2 max-h-60 overflow-y-auto pr-1'>
        <CommentRow comment={thread} />
        {replies.map((r) => (
          <CommentRow key={r.id} comment={r} indented />
        ))}
      </div>
      <div className='flex flex-col gap-2 border-t pt-2'>
        <Textarea
          value={replyMessage}
          onChange={(e) => setReplyMessage(e.target.value)}
          placeholder='Reply… @agentname to mention'
          className='min-h-16 text-sm'
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onSendReply()
            }
          }}
        />
        <Button size='sm' onClick={onSendReply} disabled={busy || !replyMessage.trim()} className='self-end'>
          {busy ? <Loader2 className='animate-spin' /> : <Send />} Reply
        </Button>
      </div>
    </div>
  )
}

function CommentRow({ comment, indented }: { comment: Comment; indented?: boolean }) {
  const isAgent = comment.author !== 'user'
  return (
    <div className={cn('flex flex-col gap-0.5', indented && 'pl-3 border-l border-border ml-1')}>
      <div className='flex items-center gap-1 text-xs'>
        <span className={cn('font-medium', isAgent ? 'text-primary' : 'text-foreground')}>{isAgent ? `@${comment.author}` : 'You'}</span>
        <span className='text-muted-foreground'>·</span>
        <span className='text-muted-foreground'>{relativeTime(comment.timestamp)}</span>
      </div>
      <p className='text-sm whitespace-pre-wrap break-words m-0'>{renderMessage(comment.message)}</p>
    </div>
  )
}
