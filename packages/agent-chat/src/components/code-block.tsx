import { Check, Copy, Download, WrapText } from 'lucide-react'
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
  /**
   * Controls for the block (copy and the like), at the right end of the
   * label's strip, or over the first line of code when there is no label.
   * With a mouse they show while the pointer is over the block or one of them
   * has keyboard focus; a click focuses a button too, but that alone does not
   * keep them over the code once the pointer leaves. A touch screen has no
   * hover, so there they always show, each a 44px target, in a strip of their
   * own height that a block with no label gains to hold them.
   */
  actions?: ReactNode
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
export function CodeFrame({ label, actions, className, children, ...props }: CodeFrameProps) {
  return (
    <div
      data-code-frame=''
      className={cn(
        'my-[var(--prose-pre-space,0.5em)] overflow-hidden rounded-[var(--prose-pre-radius,0.4rem)] border border-border bg-muted/40',
        // The frame clips, so it is also what the strip without a label is
        // placed in.
        actions && 'group/code-frame relative',
        className,
      )}
      {...props}
    >
      {label || actions ? (
        <div
          data-code-label={label ? '' : undefined}
          contentEditable={false}
          className={cn(
            label
              ? 'flex h-6 select-none items-center gap-1.5 border-border border-b pr-2 pl-4 font-mono text-[11px] text-muted-foreground leading-none'
              : 'absolute top-1.5 right-1.5 z-10 flex select-none items-center pointer-coarse:static pointer-coarse:border-border pointer-coarse:border-b',
            actions && 'pointer-coarse:h-11 pointer-coarse:pr-0',
          )}
        >
          {label}
          {actions ? (
            <div
              data-code-actions=''
              className='ml-auto flex items-center gap-1 opacity-0 transition-opacity has-[:focus-visible]:opacity-100 group-hover/code-frame:opacity-100 pointer-coarse:gap-0 pointer-coarse:opacity-100'
            >
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  )
}

/**
 * One of a code block's controls: the copy control's look, grown to a 44px
 * target on a touch screen. `pressed` makes it a toggle that shows its state.
 */
function CodeAction({
  label,
  title,
  pressed,
  onClick,
  children,
}: {
  label: string
  title: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      className='flex items-center justify-center rounded border bg-background/80 p-1 text-muted-foreground backdrop-blur-sm hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground pointer-coarse:size-11 pointer-coarse:rounded-none pointer-coarse:border-0 pointer-coarse:bg-transparent *:size-3 pointer-coarse:*:size-4'
    >
      {children}
    </button>
  )
}

export interface CodeBlockProps {
  /** The code, exactly as it was written. */
  code: string
  /**
   * The fence's info string (`ts`, `bash`, `json`, `ts title="app.ts"`), or a
   * bare language name when the caller never came through markdown at all.
   * Aliases are resolved here; anything unrecognised renders as plain text.
   */
  language?: string
  /**
   * Offer the copy and download controls, on by default. A block nobody can
   * copy is a picture of code, and the one thing a reader does with a command
   * is run it.
   */
  copyable?: boolean
  /** Added to the block's own wrapper, for the layout a surface needs. */
  className?: string
}

const COPIED_FOR_MS = 1500

// How long a download's object URL outlives the click. The click only starts
// the download, and a browser that reads the blob after the URL is revoked
// saves nothing; 40 s is FileSaver.js's figure for the same wait.
const DOWNLOAD_URL_LIFETIME_MS = 40_000

// A file extension for each fence word that is not already one. Any other
// word made of letters and digits (`ts`, `json`, `hcl`) is used as it is.
const EXTENSIONS: Record<string, string> = {
  bash: 'sh',
  'c++': 'cpp',
  console: 'sh',
  csharp: 'cs',
  docker: 'dockerfile',
  golang: 'go',
  javascript: 'js',
  kotlin: 'kt',
  make: 'mk',
  makefile: 'mk',
  markdown: 'md',
  plaintext: 'txt',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  shell: 'sh',
  shellsession: 'sh',
  text: 'txt',
  typescript: 'ts',
}

// `title="app.ts"`, `title='app.ts'` or `filename=app.ts` in the info string.
const FENCE_FILE_NAME = /(?:^|\s)(?:title|filename)=(?:"([^"]*)"|'([^']*)'|(\S+))/

/**
 * The name a block downloads under: the file its fence names, else `snippet`
 * with the extension of its language, else `snippet.txt`.
 */
export function codeFileName(info?: string): string {
  const named = info?.match(FENCE_FILE_NAME)
  // A path keeps only its last part: a download goes where the reader says.
  const file = (named?.[1] ?? named?.[2] ?? named?.[3])?.split(/[\\/]/).pop()?.trim()
  if (file) {
    return file
  }
  const word = fenceLanguage(info)?.toLowerCase()
  const extension = word ? (EXTENSIONS[word] ?? (/^[a-z0-9]+$/.test(word) ? word : null)) : null
  return `snippet.${extension ?? 'txt'}`
}

/** Save `text` as a file through a blob URL, with no request to any server. */
function saveAsFile(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS)
}

// Long lines fold inside the block instead of scrolling it. `anywhere` breaks a
// line with no spaces in it too (a URL, a hash), which would otherwise still
// overflow. On the frame, so it reaches shiki's `pre` as well as the plain one.
const WRAP_CLASS = '[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]'

/**
 * Keep a mouse drag that started in the code on the code's own lines. The
 * `pre` is looked up at the press, because highlighting replaces it when it
 * lands; a press on one of the block's controls is outside it and left alone.
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
  // Per block and not remembered: each block starts as code is written,
  // scrolling sideways, and a fold is a reading aid for this one block.
  const [wrapped, setWrapped] = useState(false)

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
  const fileName = codeFileName(language)

  // Wrap, Download, Copy, left to right: the one used most sits in the corner.
  const actions = (
    <>
      <CodeAction label='Wrap lines' title='Wrap lines' pressed={wrapped} onClick={() => setWrapped(!wrapped)}>
        <WrapText />
      </CodeAction>
      {copyable ? (
        <>
          <CodeAction
            label={`Download ${fileName}`}
            title={`Download ${fileName}`}
            onClick={() => saveAsFile(code, fileName)}
          >
            <Download />
          </CodeAction>
          <CodeAction label={copied ? 'Copied' : 'Copy code'} title={copied ? 'Copied' : 'Copy'} onClick={onCopy}>
            {copied ? <Check /> : <Copy />}
          </CodeAction>
        </>
      ) : null}
    </>
  )

  return (
    <CodeFrame
      label={label}
      actions={actions}
      className={cn(wrapped && WRAP_CLASS, className)}
      onPointerDown={keepDragOnTheLines}
    >
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
