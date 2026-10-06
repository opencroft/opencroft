'use client'

import { ClipboardList, Square, SquareCheckBig, SquarePen } from 'lucide-react'

import { Button } from 'ui/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'
import { cn } from 'cn'

/** One entry of the agent's plan (ACP `plan` session update, as the host
 * holds it -- this component never learns the wire shape). `status` and
 * `priority` are the agent's own words: the ACP spellings get the intended
 * drawing, anything else draws as pending / low. */
export interface PlanEntry {
  content: string
  status: string
  priority: string
}

export interface AgentPlanControlProps {
  /** The agent's current plan, replaced wholesale by every update. Empty
   * draws nothing. */
  entries: PlanEntry[]
  /** The button's size, matching the header's other icon controls: `icon` in
   * a pointer header, `icon-sm` on a touch cover. */
  size?: 'icon' | 'icon-sm'
  className?: string
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
}

// The frontier is the point of the drawing: done entries strike through, the
// one in progress carries the amber pen, the rest wait as empty squares.
function PlanStatusIcon({ status }: { status: string }) {
  const label = Object.hasOwn(STATUS_LABEL, status) ? STATUS_LABEL[status] : status
  const className = 'mt-0.5 size-3.5 shrink-0'
  if (status === 'completed') {
    return <SquareCheckBig role='img' aria-label={label} className={cn(className, 'text-green-500')} />
  }
  if (status === 'in_progress') {
    return <SquarePen role='img' aria-label={label} className={cn(className, 'text-amber-500')} />
  }
  return <Square role='img' aria-label={label} className={cn(className, 'text-muted-foreground')} />
}

function priorityBadgeClass(priority: string): string {
  if (priority === 'high') {
    return 'bg-destructive/10 text-destructive'
  }
  if (priority === 'medium') {
    return 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  }
  return 'bg-muted text-muted-foreground'
}

/** The plan's entries as the popover lists them: each with its status and its
 * priority. Not interactive -- the agent owns the list; the reader watches. */
export function AgentPlanList({ entries }: { entries: PlanEntry[] }) {
  return (
    <ul className='flex max-h-72 flex-col gap-0.5 overflow-y-auto'>
      {entries.map((entry, i) => (
        // Position is the only identity a plan entry has: the agent rewrites
        // the list wholesale and may repeat a line of text.
        // biome-ignore lint/suspicious/noArrayIndexKey: plan entries carry no id and their text may repeat
        <li key={i} className='flex items-start gap-2 rounded px-2 py-1.5'>
          <PlanStatusIcon status={entry.status} />
          <span
            className={cn(
              'min-w-0 flex-1 text-xs font-medium text-foreground',
              entry.status === 'completed' && 'text-muted-foreground line-through',
            )}
          >
            {entry.content}
          </span>
          {entry.priority ? (
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                priorityBadgeClass(entry.priority),
              )}
            >
              {entry.priority}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

// The agent's plan as ONE header control, the sibling of the thread's work
// control: the same ghost icon button in the header's row, with the count of
// entries not yet completed on its corner, and a popover with the current
// list. Nothing is drawn while the plan is empty -- an agent that has not
// planned, or has cleared its plan, leaves the header as it was.
export function AgentPlanControl({ entries, size = 'icon', className }: AgentPlanControlProps) {
  if (entries.length === 0) {
    return null
  }
  const done = entries.filter((entry) => entry.status === 'completed').length
  const remaining = entries.length - done
  const label = `Plan, ${done} of ${entries.length} done`
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type='button'
            variant='ghost'
            size={size}
            aria-label={label}
            title={label}
            className={cn('relative', className)}
          />
        }
      >
        <ClipboardList />
        {remaining > 0 ? (
          // The work control's badge, overlaid on the corner so the button
          // keeps its neighbours' footprint whatever the count. A finished
          // plan shows none: a zero says nothing the plain icon does not.
          <span
            aria-hidden
            className='absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground'
          >
            {remaining}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 p-1'>
        <AgentPlanList entries={entries} />
      </PopoverContent>
    </Popover>
  )
}
