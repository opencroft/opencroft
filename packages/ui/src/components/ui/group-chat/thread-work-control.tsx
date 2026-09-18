'use client'

import { Bot, ListTodo, TerminalSquare } from 'lucide-react'
import { useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'
import { cn } from 'ui/lib/utils'

/** One piece of delegated work the thread's transcript carries: a subagent or
 * a background task, named by the id its transcript block is marked with.
 * Presentational -- the host derives the list from its own session; this
 * component only lists it and hands the pressed id back. */
export interface ThreadWorkItem {
  id: string
  kind: 'subagent' | 'task'
  name: string
  /** The state badge's word -- the harness's own (running / paused /
   * completed / failed / stopped / ...). */
  state: string
  /** Still going: a running or paused task, a subagent with no terminal
   * state yet. Live entries pulse; terminal ones read as outcomes. */
  live: boolean
}

/** The delegated-work summary. `liveCount` is the button's badge (the host
 * decides what counts -- the product counts live background tasks); `onJump`
 * receives a pressed entry's id and is expected to bring that entry's
 * transcript block into view. */
export interface ThreadWork {
  items: ThreadWorkItem[]
  liveCount: number
  onJump: (id: string) => void
}

export interface ThreadWorkControlProps {
  work: ThreadWork
  /** The button's size, matching the header's other icon controls: `icon` in
   * a pointer header, `icon-sm` on a touch cover. */
  size?: 'icon' | 'icon-sm'
  className?: string
}

// The same badge palette the transcript's own subagent and task blocks wear,
// so the panel and the block a jump lands on agree about what a state looks
// like: live work pulses primary, paused holds amber, completed settles
// emerald, and every other terminal state reads muted.
function workBadgeClass(item: ThreadWorkItem): string {
  if (item.state === 'paused') {
    return 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  }
  if (item.live) {
    return 'bg-primary/10 text-primary animate-pulse'
  }
  if (item.state === 'completed') {
    return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  }
  return 'bg-muted text-muted-foreground'
}

// A thread's delegated work as ONE header control. The button is a ghost icon
// button -- the same size and shape as the header's other icon controls, so
// it sits in their row as one of them -- with the count of live work overlaid
// on its corner, and only when the count is above zero: a zero badge says
// nothing a plain icon does not. The panel lists every subagent and
// background task the transcript carries; pressing an entry hands its id to
// the host, whose jump brings that entry's block into view. The panel is an
// index of the work, not a second rendering of it, which is why every line
// names a block that exists.
//
// Nothing is drawn until there is something to list -- a control opening an
// empty panel is noise, and a thread that never delegated keeps its header
// exactly as it was.
export function ThreadWorkControl({ work, size = 'icon', className }: ThreadWorkControlProps) {
  // Controlled so choosing an entry can close the panel: the jump's landing
  // highlight is the feedback, and a popover left open would cover the very
  // block it just pointed at.
  const [open, setOpen] = useState(false)
  if (work.items.length === 0) {
    return null
  }
  const label = work.liveCount > 0 ? `Delegated work, ${work.liveCount} running` : 'Delegated work'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size={size}
          aria-label={label}
          title={label}
          className={cn('relative', className)}
        >
          <ListTodo />
          {work.liveCount > 0 ? (
            // Overlaid on the corner rather than beside the icon, so the button
            // keeps the exact footprint of its neighbours whatever the count.
            <span
              aria-hidden
              className='absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground'
            >
              {work.liveCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 p-1'>
        <div className='flex max-h-72 flex-col gap-0.5 overflow-y-auto'>
          {work.items.map((item) => (
            <button
              key={item.id}
              type='button'
              onClick={() => {
                setOpen(false)
                work.onJump(item.id)
              }}
              className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent'
            >
              {item.kind === 'subagent' ? (
                <Bot className='size-3.5 shrink-0 text-muted-foreground' />
              ) : (
                <TerminalSquare className='size-3.5 shrink-0 text-muted-foreground' />
              )}
              <span className='min-w-0 flex-1 truncate text-xs font-medium text-foreground'>{item.name}</span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${workBadgeClass(item)}`}>
                {item.state}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
