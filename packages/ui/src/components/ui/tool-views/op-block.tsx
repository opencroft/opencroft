'use client'

import { Loader2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../dialog'
import { Flex } from 'ui/components/ui/layout/flex'
import { cn } from 'ui/lib/utils'
import { useToolViewHost } from './tool-view-host'

// Lines a preview is capped to before showing a "there's more" cue — same
// threshold callers use to decide whether to pass `overflowing`.
export const CLAMP_LINES = 3

// A one-line header (label) with the target shown as a small clickable line
// underneath, and the body always expanded below — matching agent-chat's
// ToolCallBlock styling, so the remote op views (Read/Write/Edit/Script/Exec)
// read consistently with plain tool calls in the chat transcript.
//
// The inline preview is capped to a few lines and can't be scrolled — a chat
// transcript already scrolls, and a nested scroll area inside it is a bad
// interaction. `overflowing` (the caller knows whether its own content — text
// or a diff — actually exceeds the cap) adds an inset shadow at the bottom
// edge as a "there's more" cue. Clicking the header or the preview (anywhere
// but the separate target line) opens the SAME children raw (uncapped,
// interactive) in a dialog sized to the viewport — the only way to see the
// rest / interact with a diff. The preview clamp is applied here, once,
// around the inline copy only, not around the dialog's.
export function OpBlock({
  verb,
  detail,
  target,
  isError,
  pending,
  overflowing,
  children,
}: {
  // The action word (Read/Write/Edit/Script/Exec/Call), rendered bold.
  verb: string
  // The rest of the label (path/description/action), normal weight.
  detail?: string
  target?: string
  isError?: boolean
  // True while the call hasn't resolved yet — shows a spinner in the header,
  // same as agent-chat's ToolCallBlock.
  pending?: boolean
  overflowing?: boolean
  children?: ReactNode
}) {
  const [fullOpen, setFullOpen] = useState(false)
  const openFull = () => children && setFullOpen(true)
  return (
    <Flex className='w-full min-w-0 gap-1'>
      <button
        type='button'
        onClick={openFull}
        className='flex w-full min-w-0 items-center gap-2 text-left text-xs cursor-pointer'
      >
        <span className='font-mono min-w-0 flex-1 break-all'>
          <span className='font-semibold'>{verb}</span>
          {detail && <> {detail}</>}
        </span>
        {pending && <Loader2 className='size-3 shrink-0 animate-spin text-muted-foreground' />}
        {isError && <span className='text-destructive shrink-0'>error</span>}
      </button>
      {target && <TargetLine target={target} />}
      {children && (
        <button
          type='button'
          onClick={openFull}
          className={cn(
            'w-full rounded-md border bg-muted/30 text-left text-xs overflow-hidden cursor-pointer',
            isError && 'border-destructive/60',
          )}
        >
          <div
            className={cn(
              'max-h-48 overflow-hidden pointer-events-none',
              overflowing && 'shadow-[inset_0_-12px_8px_-8px_rgba(0,0,0,0.35)]',
            )}
          >
            {children}
          </div>
        </button>
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
  return (text ?? '').split('\n').length > CLAMP_LINES
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
