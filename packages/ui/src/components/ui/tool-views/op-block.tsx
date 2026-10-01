import { Loader2 } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useState } from 'react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../dialog'
import { Flex } from 'ui/components/ui/layout/flex'
import { cn } from 'cn'
import { type DiffLine, DiffStat, DiffView, diffRowCount } from './diff-view'
import { useToolViewHost } from './tool-view-host'

// Lines of body text that fit the preview's height — the threshold callers use
// to decide whether to pass `overflowing`.
export const CLAMP_LINES = 8

// A one-line header (label) with the target shown as a small clickable line
// underneath, and the body always expanded below — matching agent-chat's
// ToolCallBlock styling, so the remote op views (Read/Write/Edit/Script/Exec)
// read consistently with plain tool calls in the chat transcript.
//
// The inline preview is capped to a few lines and can't be scrolled — a chat
// transcript already scrolls, and a nested scroll area inside it is a bad
// interaction. `overflowing` (the caller knows whether its own content — text
// or a diff — actually exceeds the cap) fades the bottom edge as a "there's
// more" cue. Clicking the header or the preview (anywhere
// but the separate target line) opens the children uncapped and interactive
// in a dialog sized to the viewport — the only way to see the rest. The inline
// copy is `inert`: it is a picture of the body, and a control inside it (a
// folded diff run) is operated in the dialog. `preview`, when given, is drawn
// inline instead of the children — for a body whose useful part is not its
// top, such as the end of a command's output.
export function OpBlock({
  verb,
  detail,
  meta,
  target,
  isError,
  pending,
  overflowing,
  preview,
  children,
}: {
  // The action word (Read/Write/Edit/Script/Exec/Call), rendered bold.
  verb: string
  // The rest of the label (path/description/action), normal weight.
  detail?: string
  // A short fact about the result at the header's end: a diff's size, a line
  // count.
  meta?: ReactNode
  target?: string
  isError?: boolean
  // True while the call hasn't resolved yet — shows a spinner in the header,
  // same as agent-chat's ToolCallBlock.
  pending?: boolean
  overflowing?: boolean
  preview?: ReactNode
  children?: ReactNode
}) {
  const [fullOpen, setFullOpen] = useState(false)
  const openFull = () => children && setFullOpen(true)
  const onPreviewKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openFull()
    }
  }
  return (
    <Flex className='w-full min-w-0 gap-1'>
      <button
        type='button'
        onClick={openFull}
        className='flex w-full min-w-0 items-center gap-2 text-left text-xs cursor-pointer'
      >
        <span className='font-mono min-w-0 flex-1 wrap-anywhere'>
          <span className='font-semibold'>{verb}</span>
          {detail && <> {detail}</>}
        </span>
        {meta}
        {pending && <Loader2 className='size-3 shrink-0 animate-spin text-muted-foreground' />}
        {isError && <span className='text-destructive shrink-0'>error</span>}
      </button>
      {target && <TargetLine target={target} />}
      {children && (
        // A div rather than a button: the body may hold buttons of its own,
        // and a button cannot contain one. The body inside is inert and so has
        // no accessible text, which is why the button is labelled.
        <div
          role='button'
          tabIndex={0}
          aria-label={`Show all of ${detail ? `${verb} ${detail}` : verb}`}
          onClick={openFull}
          onKeyDown={onPreviewKey}
          className={cn(
            'w-full min-w-0 rounded-md border bg-muted/30 text-left text-xs overflow-hidden cursor-pointer',
            isError && 'border-destructive/60',
          )}
        >
          <div
            inert
            className={cn(
              'max-h-48 overflow-hidden',
              // A fade rather than a shadow: it is drawn in the content's own
              // colours, so it reads the same in every theme.
              overflowing && 'mask-b-from-70%',
            )}
          >
            {preview ?? children}
          </div>
        </div>
      )}
      {children && (
        <Dialog open={fullOpen} onOpenChange={setFullOpen}>
          <DialogContent className='flex h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-3 sm:max-w-[95vw]'>
            <DialogHeader>
              <DialogTitle className='font-mono text-sm font-normal'>
                <span className='font-semibold'>{verb}</span>
                {detail && <> {detail}</>}
              </DialogTitle>
            </DialogHeader>
            <div className='min-h-0 flex-1 overflow-auto text-xs'>{children}</div>
          </DialogContent>
        </Dialog>
      )}
    </Flex>
  )
}

// The transcript form of every edit-shaped call: the op-block header with the
// diff's size, and the diff as the body. `diffs` holds one diff per edit the
// call made, drawn in order under a small "Edit n of m" line when there are
// several (`part` names them, for parts that are not edits). `lead` is drawn
// above them, for what the call changed besides a text (a skill's
// description). No diffs at all means the call's change is not known here,
// which is said rather than drawn as an empty change.
export function DiffOpBlock({
  verb,
  detail,
  target,
  result,
  lead,
  diffs,
  part = 'Edit',
}: {
  verb: string
  detail?: string
  target?: string
  result?: { isError?: boolean }
  lead?: ReactNode
  diffs: readonly (readonly DiffLine[])[]
  part?: string
}) {
  const all = diffs.flat()
  return (
    <OpBlock
      verb={verb}
      detail={detail}
      target={target}
      meta={diffs.length > 0 && <DiffStat diff={all} />}
      isError={result?.isError}
      pending={!result}
      overflowing={diffs.reduce((rows, diff) => rows + diffRowCount(diff), 0) > CLAMP_LINES}
    >
      {lead}
      {diffs.length === 0 && (
        <div className={cn('px-3 py-2 text-xs text-muted-foreground', lead && 'border-t')}>
          The change is not in the transcript.
        </div>
      )}
      {diffs.map((diff, index) => (
        // An edits list is ordered and has no ids: position is the identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: an edit's position is its identity
        <div key={index} className={cn((lead || index > 0) && 'border-t')}>
          {diffs.length > 1 && (
            <div className='px-3 pt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground'>
              {part} {index + 1} of {diffs.length}
            </div>
          )}
          <DiffView diff={diff} />
        </div>
      ))}
    </OpBlock>
  )
}

export function OpRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex row className='w-full gap-3 px-3 py-2'>
      <div className='w-12 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground pt-0.5'>{label}</div>
      <div className='flex-1 min-w-0'>{children}</div>
    </Flex>
  )
}

// Whether a text block's line count exceeds the preview clamp — the plain-text
// half of what callers pass as OpBlock's `overflowing` (diffs decide their own).
export function exceedsClamp(text: string | undefined): boolean {
  return lineCount(text) > CLAMP_LINES
}

export function lineCount(text: string | undefined): number {
  return text ? text.replace(/\n$/, '').split('\n').length : 0
}

// The header's quiet fact about a result, as plain text.
export function OpMeta({ text }: { text?: string }) {
  return text ? <span className='shrink-0 text-[10px] text-muted-foreground'>{text}</span> : null
}

// "12 lines" — the size a header states for a text body; nothing for one line.
export function linesLabel(text: string | undefined): string | undefined {
  const count = lineCount(text)
  return count > 1 ? `${count} lines` : undefined
}

// A block of tool text: wrapped, never scrolled sideways. `head` keeps only the
// first lines and `tail` only the last, each saying how many it left out — a
// preview keeps a command short and the end of its output, which is where the
// part that matters usually is.
export function OpText({ text, head, tail }: { text: string; head?: number; tail?: number }) {
  const lines = text.replace(/\n$/, '').split('\n')
  const cut = (limit: number | undefined) => (limit !== undefined && lines.length > limit ? lines.length - limit : 0)
  const before = cut(tail)
  const after = cut(head)
  const shown = before > 0 ? lines.slice(before) : after > 0 ? lines.slice(0, head) : null
  return (
    <>
      {before > 0 && <Elided>⋯ {before} earlier lines</Elided>}
      <pre className='m-0 whitespace-pre-wrap wrap-anywhere text-[11px] text-muted-foreground'>
        {shown ? shown.join('\n') : text}
      </pre>
      {after > 0 && <Elided>⋯ {after} more lines</Elided>}
    </>
  )
}

function Elided({ children }: { children: ReactNode }) {
  return <div className='text-[11px] text-muted-foreground/70'>{children}</div>
}

// What a call returned, or where it stands while it has not: a spinner until a
// result arrives, a word when it arrived empty.
export function OpOutput({ result, tail }: { result?: { text: string }; tail?: number }) {
  if (!result) {
    return (
      <Flex row align='center' className='gap-1.5 text-muted-foreground'>
        <Loader2 className='size-3 animate-spin' />
        <span>running…</span>
      </Flex>
    )
  }
  return result.text ? <OpText text={result.text} tail={tail} /> : <span className='text-muted-foreground'>No output</span>
}

// Named values — a call's arguments, a node's changed properties — as
// label/value pairs. A string is shown as written; anything else as indented
// JSON, the only faithful form for a nested value.
export function OpFields({ values }: { values: Record<string, unknown> }) {
  return (
    <div className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2'>
      {Object.entries(values).map(([key, value]) => (
        <OpField key={key} label={key} value={value} />
      ))}
    </div>
  )
}

function OpField({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value))
  return (
    <>
      <div className='font-mono text-[11px] text-muted-foreground/80'>{label}</div>
      <pre className='m-0 min-w-0 whitespace-pre-wrap wrap-anywhere text-[11px] text-muted-foreground'>{text}</pre>
    </>
  )
}

// A tool's structured answer can arrive as JSON on one line. Shown to a person,
// a JSON object or array is laid out the way JSON.stringify(value, null, 2)
// would lay it out; any other text is returned as it came. Only the whitespace
// between tokens changes: every value is copied as written rather than parsed
// and printed again, so a number too long for a double keeps all its digits and
// an escape in a string stays the escape it was.
export function readableJson(text: string): string {
  const first = text.trimStart()[0]
  if (first !== '{' && first !== '[') {
    return text
  }
  try {
    JSON.parse(text)
  } catch {
    return text
  }
  let out = ''
  let depth = 0
  let inString = false
  const newline = () => `\n${'  '.repeat(depth)}`
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        i++
        out += text[i]
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '{' || ch === '[') {
      let next = i + 1
      while (' \t\n\r'.includes(text[next])) next++
      if (text[next] === (ch === '{' ? '}' : ']')) {
        out += ch + text[next]
        i = next
      } else {
        depth++
        out += ch + newline()
      }
    } else if (ch === '}' || ch === ']') {
      depth--
      out += newline() + ch
    } else if (ch === ',') {
      out += `,${newline()}`
    } else if (ch === ':') {
      out += ': '
    } else if (!' \t\n\r'.includes(ch)) {
      if (ch === '"') {
        inString = true
      }
      out += ch
    }
  }
  return out
}

// The call's target ("<node-id>/<handle-id>"), shown as a small line under the
// header rather than hidden behind a hover tooltip. Where the host has a canvas
// it resolves the node's name and clicking focuses it (the same affordance the
// approval list offers via its "View node" button); on a surface without one it
// is the plain target text.
function TargetLine({ target }: { target: string }) {
  const { canvas } = useToolViewHost()
  const [nodeId, handleId] = target.split('/')
  const name = canvas?.getNode(nodeId)?.data?.name as string | undefined
  const label = name ? `${name} (${nodeId})` : nodeId
  const value = handleId ? `${label}/${handleId}` : label

  // No canvas to focus: the target is still worth showing, but as the text it
  // is. A button here would look live and do nothing.
  if (!canvas) {
    return <span className='block max-w-full break-all text-[10px] text-muted-foreground/80'>{value}</span>
  }

  return (
    <button
      type='button'
      onClick={() => canvas.focusNode(nodeId)}
      className='block max-w-full break-all text-left text-[10px] text-muted-foreground/80 hover:underline'
    >
      {value}
    </button>
  )
}
