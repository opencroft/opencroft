'use client'

import { ChevronRight, Loader2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Flex } from 'ui/components/ui/layout/flex'
import { cn } from 'ui/lib/utils'

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

// A collapsible tool-call row: a one-line header (name + arg preview + running /
// error state) that expands to reveal the full args and output.
export function ToolCallBlock({ name, args, result }: ToolCallBlockProps) {
  const isError = result?.isError === true
  const [open, setOpen] = useState(false)
  const preview = previewArg(name, args)
  return (
    <Flex className='gap-1.5'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex items-center gap-2 text-xs text-left cursor-pointer'
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className='font-mono font-medium shrink-0'>{name}</span>
        {preview && <span className='font-mono text-muted-foreground'>{preview}</span>}
        {!result && !open && <Loader2 className='size-3 shrink-0 animate-spin text-muted-foreground' />}
        {isError && <span className='text-destructive shrink-0'>error</span>}
      </button>
      {open && (
        <div
          className={cn('rounded-md border bg-muted/30 text-xs overflow-hidden', isError && 'border-destructive/60')}
        >
          <ToolRow label='args'>
            <pre className='max-h-48 overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>
              {JSON.stringify(args, null, 2)}
            </pre>
          </ToolRow>
          <div className='border-t' />
          <ToolRow label='output'>
            {result ? (
              <pre className='overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>
                {result.text}
              </pre>
            ) : (
              <Flex row align='center' className='gap-1.5 text-muted-foreground'>
                <Loader2 className='size-3 animate-spin' />
                <span>running…</span>
              </Flex>
            )}
          </ToolRow>
        </div>
      )}
    </Flex>
  )
}

function ToolRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex row className='gap-3 px-3 py-2'>
      <div className='w-10 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground pt-0.5'>{label}</div>
      <div className='flex-1 min-w-0'>{children}</div>
    </Flex>
  )
}
