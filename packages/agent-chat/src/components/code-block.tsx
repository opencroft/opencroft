import { Check, Copy } from 'lucide-react'
import { type PointerEvent, useEffect, useState } from 'react'
import { cn } from 'cn'

import { CODE_SCROLL_CLASS, highlight, resolveLanguage } from './code-highlight'

export interface CodeBlockProps {
  /** The code, exactly as it was written. */
  code: string
  /**
   * The fence's info string (`ts`, `bash`, `json`), or a bare language name
   * when the caller never came through markdown at all. Aliases are resolved
   * here; anything unrecognised renders as plain text.
   */
  language?: string
  /**
   * Offer a copy control, on by default. A block nobody can copy is a picture
   * of code, and the one thing a reader does with a command is run it.
   */
  copyable?: boolean
  /** Added to the block's own wrapper, for the layout a surface needs. */
  className?: string
}

const COPIED_FOR_MS = 1500

/**
 * Keep a mouse drag that started in the code on the code's own lines.
 *
 * A drag past the block's edge scrolls the code, but the browser takes the
 * selection's end from whatever element is under the pointer. Beside a block
 * that is often not part of it -- a timeline rail, a scrollbar, a page's
 * margin -- and then the selection jumps out of the block, or stops while the
 * code keeps scrolling under it. Two things keep it on the line:
 *
 * - While the pointer is level with the lines the code captures it, so the
 *   pointer's moves land on the code and the browser scrolls the code, not
 *   whatever scrolls around it.
 * - While the pointer is beside the lines, every frame puts the selection's
 *   end back on the character at the edge the pointer left by. The browser's
 *   autoscroll moves it each frame from a fresh look at what is under the
 *   pointer, which capture does not change, so a pointer held still beside the
 *   block would otherwise leave the selection on the neighbour.
 *
 * Above or below the block the capture is let go and the frames do nothing, so
 * a selection runs on into the text around it as it does anywhere else. Touch
 * is left alone: it selects with handles, not a drag.
 */
function keepDragOnTheLines(event: PointerEvent<HTMLElement>) {
  const code = event.currentTarget.querySelector('pre')
  if (event.pointerType !== 'mouse' || event.button !== 0 || !code?.contains(event.target as Node)) {
    return
  }
  const pointer = event.pointerId
  let { clientX: x, clientY: y } = event
  let frame = 0
  const follow = (move: { pointerId: number; clientX: number; clientY: number }) => {
    if (move.pointerId !== pointer) {
      return
    }
    x = move.clientX
    y = move.clientY
    // Highlighting replaces the `pre` when it lands, and a pointer cannot be
    // captured by an element that has left the document.
    if (!code.isConnected) {
      release()
      return
    }
    const { top, bottom } = code.getBoundingClientRect()
    const level = y >= top && y <= bottom
    if (level === code.hasPointerCapture(pointer)) {
      return
    }
    if (level) {
      code.setPointerCapture(pointer)
    } else {
      code.releasePointerCapture(pointer)
    }
  }
  const holdTheEnd = () => {
    frame = requestAnimationFrame(holdTheEnd)
    if (!code.isConnected) {
      release()
      return
    }
    const { top, bottom, left, right } = code.getBoundingClientRect()
    if (y < top || y > bottom || (x >= left && x <= right)) {
      return
    }
    const caret = caretAt(Math.min(Math.max(x, left + 1), right - 1), y)
    const selection = window.getSelection()
    // Off the code's text -- under the copy control on the first line -- the
    // browser's own answer stands.
    if (caret && code.contains(caret.node) && selection?.rangeCount) {
      selection.extend(caret.node, caret.offset)
    }
  }
  const release = () => {
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', follow, true)
    window.removeEventListener('pointerup', release, true)
    window.removeEventListener('pointercancel', release, true)
  }
  window.addEventListener('pointermove', follow, true)
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  frame = requestAnimationFrame(holdTheEnd)
  follow(event)
}

/** The text position at a point in the viewport, from whichever API the browser has. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(x, y)
    return position && { node: position.offsetNode, offset: position.offset }
  }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/**
 * A fenced code block as the reader meets it in a conversation.
 *
 * The colours are VS Code's own, drawn for light and dark at the same time and
 * selected by CSS, so changing theme re-paints nothing.
 */
export function CodeBlock({ code, language, copyable = true, className }: CodeBlockProps) {
  const grammar = resolveLanguage(language)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Text first, colour second. The block renders as plain code immediately and
  // gains its highlighting when the grammar has arrived -- a block that waited
  // for a grammar before showing anything would hold back the one thing the
  // reader came for, and while a reply streams the text changes faster than any
  // highlighter could keep up with anyway.
  useEffect(() => {
    if (!grammar) {
      setHtml(null)
      return
    }
    let live = true
    void highlight(code, grammar).then((result) => {
      if (live) {
        setHtml(result)
      }
    })
    return () => {
      live = false
    }
  }, [code, grammar])

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), COPIED_FOR_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const onCopy = () => {
    // `writeText` rejects outside a secure context and in an unfocused
    // document. Saying nothing is the right failure: the control simply does
    // not confirm, and selecting the text by hand still works.
    void navigator.clipboard
      ?.writeText(code)
      .then(() => setCopied(true))
      .catch(() => {})
  }

  return (
    <div className={cn('group relative', className)} onPointerDown={keepDragOnTheLines}>
      {copyable ? (
        <button
          type='button'
          onClick={onCopy}
          title={copied ? 'Copied' : 'Copy'}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className='absolute top-1.5 right-1.5 z-10 rounded border bg-background/80 p-1 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground'
        >
          {copied ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
        </button>
      ) : null}
      {html ? (
        // biome-ignore lint: the markup is shiki's own and the code inside it is escaped by shiki, not passed through
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre data-code-block='' className={CODE_SCROLL_CLASS}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
