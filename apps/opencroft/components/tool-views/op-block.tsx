'use client'

import { useReactFlow } from '@xyflow/react'
import { Maximize2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/dialog'
import { Flex } from 'ui/layout/flex'

import { sseEventsStore } from '@/app/(sse)/_lib/sse-events-store'
import { cn } from '@/lib/utils'

// Lines a preview is capped to before showing a "there's more" cue — same
// threshold callers use to decide whether to pass `overflowing`.
export const CLAMP_LINES = 3

// A one-line header (label + a "view full" button) with the target shown as a
// small clickable line underneath, and the body always expanded below —
// matching agent-chat's ToolCallBlock styling, so the remote op views
// (Read/Write/Edit/Script/Exec) read consistently with plain tool calls in
// the chat transcript.
//
// The inline preview is capped to a few lines and can't be scrolled — a chat
// transcript already scrolls, and a nested scroll area inside it is a bad
// interaction. `overflowing` (the caller knows whether its own content — text
// or a diff — actually exceeds the cap) adds an inset shadow at the bottom
// edge as a "there's more" cue. "View full" opens the SAME children raw
// (uncapped, interactive) in a dialog sized to the viewport, which is the only
// way to see the rest / interact with a diff — the preview clamp is applied
// here, once, around the inline copy only, not around the dialog's.
export function OpBlock({
  verb,
  detail,
  target,
  isError,
  overflowing,
  children,
}: {
  // The action word (Read/Write/Edit/Script/Exec/Call), rendered bold.
  verb: string
  // The rest of the label (path/description/action), normal weight.
  detail?: string
  target?: string
  isError?: boolean
  overflowing?: boolean
  children?: ReactNode
}) {
  const [fullOpen, setFullOpen] = useState(false)
  return (
    <Flex className='w-full min-w-0 gap-1'>
      <div className='flex w-full min-w-0 items-center gap-2 text-xs'>
        <span className='font-mono min-w-0 flex-1 break-all'>
          <span className='font-semibold'>{verb}</span>
          {detail && <> {detail}</>}
        </span>
        {isError && <span className='text-destructive shrink-0'>error</span>}
        {children && (
          <button
            type='button'
            onClick={() => setFullOpen(true)}
            title='View full'
            className='shrink-0 rounded-md border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
          >
            <Maximize2 className='size-3' />
          </button>
        )}
      </div>
      {target && <TargetLine target={target} />}
      {children && (
        <div
          className={cn(
            'w-full rounded-md border bg-muted/30 text-xs overflow-hidden',
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

// The call's target ("<node-id>/<handle-id>"), shown as a small clickable
// line under the header rather than hidden behind a hover tooltip — clicking
// pans the canvas to that node (the same affordance the approval list offers
// via its "View node" button).
function TargetLine({ target }: { target: string }) {
  const { getNode } = useReactFlow()
  const [nodeId, handleId] = target.split('/')
  const node = getNode(nodeId) as { data?: { name?: string } } | undefined
  const name = node?.data?.name
  const label = name ? `${name} (${nodeId})` : nodeId
  const value = handleId ? `${label}/${handleId}` : label
  return (
    <button
      type='button'
      onClick={() => sseEventsStore.dispatch({ type: 'focus_node', nodeId, panToNode: true })}
      className='block max-w-full break-all text-left text-[10px] text-muted-foreground/80 hover:underline'
    >
      {value}
    </button>
  )
}
