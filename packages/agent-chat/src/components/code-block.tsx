import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from 'ui/lib/utils'

import { highlight, resolveLanguage } from './code-highlight'

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
    <div className={cn('group relative', className)}>
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
        <pre data-code-block=''>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
