import { Check, Copy } from 'lucide-react'
import { type ComponentProps, type PointerEvent, type ReactNode, useEffect, useState } from 'react'
import { cn } from 'cn'

import { CODE_PRE_CLASS, fenceLanguage, highlight, resolveLanguage } from './code-highlight'
import { keepDragInScrollBox } from './scroll-box-drag'

export interface CodeFrameProps extends ComponentProps<'div'> {
  /**
   * What heads the code: its language, or a change of it. A frame given
   * nothing has no header, so a block that names no language shows none.
   */
  label?: ReactNode
}

/**
 * The box every code block is set in -- a rendered block, one being edited, a
 * code diff -- with the label over the code, so the three read as one thing.
 * The code goes inside as a bare `pre` (`CODE_PRE_CLASS`): the frame draws the
 * border, tint and rounding, and takes the prose's code-block spacing and
 * radius where there is prose around it.
 *
 * The label is a strip of its own above the code rather than a tag laid over
 * it, so it never covers a character and stays put while a long line scrolls.
 * It is left out of a selection and out of editing: what is selected, typed
 * or copied in a block is its code.
 */
export function CodeFrame({ label, className, children, ...props }: CodeFrameProps) {
  return (
    <div
      data-code-frame=''
      className={cn(
        'my-[var(--prose-pre-space,0.5em)] overflow-hidden rounded-[var(--prose-pre-radius,0.4rem)] border border-border bg-muted/40',
        className,
      )}
      {...props}
    >
      {label ? (
        <div
          data-code-label=''
          contentEditable={false}
          className='flex h-6 select-none items-center gap-1.5 border-border border-b pr-2 pl-4 font-mono text-[11px] text-muted-foreground leading-none'
        >
          {label}
        </div>
      ) : null}
      {children}
    </div>
  )
}

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
 * Keep a mouse drag that started in the code on the code's own lines. The
 * `pre` is looked up at the press, because highlighting replaces it when it
 * lands; a press on the copy control is outside it and left alone.
 */
function keepDragOnTheLines(event: PointerEvent<HTMLElement>) {
  keepDragInScrollBox(event, event.currentTarget.querySelector('pre'))
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

  const label = fenceLanguage(language)

  return (
    <CodeFrame label={label} className={cn('group relative', className)} onPointerDown={keepDragOnTheLines}>
      {copyable ? (
        <button
          type='button'
          onClick={onCopy}
          title={copied ? 'Copied' : 'Copy'}
          aria-label={copied ? 'Copied' : 'Copy code'}
          // Under a label the control sits in the label's strip, centred on
          // it; without one, on the first line of the code.
          className={cn(
            'absolute right-1.5 z-10 rounded border bg-background/80 p-1 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground',
            label ? 'top-px' : 'top-1.5',
          )}
        >
          {copied ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
        </button>
      ) : null}
      {html ? (
        // biome-ignore lint: the markup is shiki's own and the code inside it is escaped by shiki, not passed through
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre data-code-block='' className={CODE_PRE_CLASS}>
          <code>{code}</code>
        </pre>
      )}
    </CodeFrame>
  )
}
