import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { cn } from 'cn'

import { highlight, resolveLanguage } from './code-highlight'

// One object, applied to both layers. A caret lands on the right glyph only
// while the text being typed and the text being read agree on every property
// that decides where a character goes -- font, size, line height, tab size,
// padding, wrapping. Written once and used twice, so a later edit cannot move
// one of them without moving the other.
const TEXT_STYLE: CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
  fontSize: 13,
  lineHeight: 1.6,
  tabSize: 2,
  padding: 12,
  margin: 0,
  whiteSpace: 'pre',
  letterSpacing: 'normal',
  border: 0,
  background: 'transparent',
}

// Kept next to TEXT_STYLE because the height below is computed from them, and
// changing one without the other would size the box against its own contents.
const LINE_HEIGHT_PX = 21
const PADDING_PX = 12

export interface CodeBlockEditorProps {
  /** The code being edited. Controlled -- the caller holds it. */
  value: string
  onChange: (value: string) => void
  /**
   * The fence's info string or a bare language name, resolved the same way
   * `CodeBlock` resolves it. An unknown language edits fine, uncoloured.
   */
  language?: string
  /** The shortest the editor gets, in lines, so an empty one is not a slot. */
  minLines?: number
  /** Added to the editor's own box, for the layout a surface needs. */
  className?: string
}

/**
 * Code that can be edited in place, with a textarea rather than an editor.
 *
 * The transparent-textarea-over-highlighted-text technique, and it is chosen
 * over mounting a real editor deliberately: it costs nothing to appear, so a
 * page can carry a dozen of these and any one of them can be typed into the
 * instant it renders. A full editor buys line numbers, find and an undo stack
 * of its own, and pays for them with a mount -- the right trade for one editor
 * on a page and the wrong one for twelve.
 */
export function CodeBlockEditor({ value, onChange, language, minLines = 6, className }: CodeBlockEditorProps) {
  const grammar = resolveLanguage(language)
  const [html, setHtml] = useState<string | null>(null)

  // Re-highlighted on every keystroke, and that is affordable because the work
  // is proportional to this one block rather than to the page. The text is
  // never held back waiting for it: the layer underneath falls back to plain
  // text, so a keystroke is visible before it is coloured.
  useEffect(() => {
    if (!grammar) {
      setHtml(null)
      return
    }
    let live = true
    void highlight(value, grammar, { plain: true }).then((result) => {
      if (live) {
        setHtml(result)
      }
    })
    return () => {
      live = false
    }
  }, [value, grammar])

  const lines = Math.max(minLines, value.split('\n').length)
  const height = lines * LINE_HEIGHT_PX + PADDING_PX * 2

  return (
    <div className={cn('relative overflow-auto rounded-md border bg-muted/40', className)} style={{ height }}>
      {html ? (
        // biome-ignore lint: shiki's own markup, with the code inside it escaped by shiki rather than passed through
        <div aria-hidden className='pointer-events-none' style={TEXT_STYLE} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre aria-hidden className='pointer-events-none' style={TEXT_STYLE}>
          {value}
        </pre>
      )}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        autoCapitalize='off'
        autoCorrect='off'
        className='absolute inset-0 resize-none outline-none'
        // Transparent text is what makes the layering work: what is typed is
        // invisible and the highlighted copy underneath is what the reader sees.
        // The caret is the one part that stays drawn.
        style={{ ...TEXT_STYLE, color: 'transparent', caretColor: 'var(--foreground)', overflow: 'hidden' }}
      />
    </div>
  )
}
