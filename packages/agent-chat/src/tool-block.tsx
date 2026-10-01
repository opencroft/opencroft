'use client'

import { cn } from 'cn'
import { ChevronRight, Loader2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/components/ui/dialog'
import { Flex } from 'ui/components/ui/layout/flex'

export interface ToolCallResult {
  text: string
  isError?: boolean
}

export interface ToolCallBlockProps {
  // Tool name, shown in the collapsed header.
  name: string
  // Tool input, rendered as pretty JSON when expanded.
  args?: unknown
  // Tool output; absent while the call is still running.
  result?: ToolCallResult
}

// Tool name -> the single argument worth previewing inline next to the name.
const PREVIEW_ARG: Record<string, string> = {
  edit: 'path',
  read: 'path',
  write: 'path',
  list: 'path',
  glob: 'pattern',
  grep: 'pattern',
  search: 'pattern',
  exec: 'command',
  bash: 'command',
  run: 'command',
  fetch: 'url',
  url: 'url',
  web_fetch: 'url',
}

// A short, human-readable preview of a tool's primary argument (the path for
// `read`, the command for `bash`, …), or null when there's nothing handy.
export function previewArg(name: string, args: unknown): string | null {
  const key = PREVIEW_ARG[name.toLowerCase()]
  if (!key || !args || typeof args !== 'object') {
    return null
  }
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string' || !value) {
    return null
  }
  return value
}

// The args/output content shared between the inline (clamped) preview and the
// fullscreen dialog — identical markup, just constrained differently by the
// caller's wrapping element.
function ToolCallContent({ args, result }: { args?: unknown; result?: ToolCallResult }) {
  return (
    <>
      <ToolRow label='args'>
        <pre className='whitespace-pre text-[11px] text-muted-foreground'>{JSON.stringify(args, null, 2)}</pre>
      </ToolRow>
      <div className='border-t' />
      <ToolRow label='output'>
        {result ? (
          <pre className='whitespace-pre text-[11px] text-muted-foreground'>{result.text}</pre>
        ) : (
          <Flex row align='center' className='gap-1.5 text-muted-foreground'>
            <Loader2 className='size-3 animate-spin' />
            <span>running…</span>
          </Flex>
        )}
      </ToolRow>
    </>
  )
}

// A collapsible tool-call row: a one-line header (name + arg preview + running /
// error state) that expands to reveal a clamped preview of the full args and
// output. Clicking the preview (once expanded) opens the same content raw
// (uncapped, scrollable) in a fullscreen dialog — the preview itself never
// scrolls, since it already sits inside a scrolling transcript.
export function ToolCallBlock({ name, args, result }: ToolCallBlockProps) {
  const isError = result?.isError === true
  const [open, setOpen] = useState(false)
  const [fullOpen, setFullOpen] = useState(false)
  const preview = previewArg(name, args)

  // The preview clamps to a fixed height (below) and routes clicks to a
  // fullscreen dialog instead of scrolling in place — a chat transcript
  // already scrolls, and a nested scroll area inside it is a bad interaction.
  // Whether the "there's more" shadow shows must match that real clamp, not
  // an estimated line count: pretty-printed JSON is short-but-wide as often
  // as it's long, so a line-count heuristic both over- and under-fires.
  const [overflowing, setOverflowing] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) {
      return
    }
    const el = contentRef.current
    setOverflowing(el ? el.scrollHeight > el.clientHeight : false)
  }, [open, args, result])

  return (
    <Flex className='w-full min-w-0 gap-1.5'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex min-w-0 items-start gap-2 text-xs text-left cursor-pointer'
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className='font-mono font-medium break-all'>{name}</span>
        {preview && <span className='font-mono text-muted-foreground min-w-0 flex-1 break-all'>{preview}</span>}
        {!result && !open && <Loader2 className='size-3 animate-spin text-muted-foreground' />}
        {isError && <span className='text-destructive'>error</span>}
      </button>
      {open && (
        <>
          <button
            type='button'
            onClick={() => setFullOpen(true)}
            className={cn(
              'w-full rounded-md border bg-muted/30 text-left text-xs overflow-hidden cursor-pointer',
              isError && 'border-destructive/60',
            )}
          >
            <div
              ref={contentRef}
              className={cn(
                'max-h-48 overflow-hidden pointer-events-none',
                overflowing && 'shadow-[inset_0_-12px_8px_-8px_rgba(0,0,0,0.35)]',
              )}
            >
              <ToolCallContent args={args} result={result} />
            </div>
          </button>
          <Dialog open={fullOpen} onOpenChange={setFullOpen}>
            <DialogContent className='flex h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-3 sm:max-w-[95vw]'>
              <DialogHeader>
                <DialogTitle className='font-mono text-sm font-normal'>
                  <span className='font-semibold'>{name}</span>
                  {preview && <> {preview}</>}
                </DialogTitle>
              </DialogHeader>
              <div className='min-h-0 flex-1 overflow-auto text-xs'>
                <ToolCallContent args={args} result={result} />
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </Flex>
  )
}

function ToolRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex row className='w-full gap-3 px-3 py-2'>
      <div className='w-10 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground pt-0.5'>{label}</div>
      <div className='flex-1 min-w-0'>{children}</div>
    </Flex>
  )
}
