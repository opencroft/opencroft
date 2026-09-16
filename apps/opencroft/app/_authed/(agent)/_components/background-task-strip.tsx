'use client'

import type { AsyncTaskInfo } from 'agent-client/types'
import { Loader2, Pause, Square } from 'lucide-react'

import { Button } from 'ui/components/ui/button'

// The live background-work strip: the detached tasks a harness reported that
// keep running with no prompt turn active (a background bash job, a loop). It
// is what makes that work visible at all — before this, a session running one
// looked idle. Rendered beside the conversation, above the composer, next to
// the approval prompts, so a reader sees present-tense work in the one place
// they already look for things needing their attention.
//
// Only LIVE tasks reach it (the session filters to running/paused); a finished
// task drops off rather than lingering. A task the harness marked stoppable
// gets a Stop button that ends just that task, never the turn.
export function BackgroundTaskStrip({
  tasks,
  onStop,
}: {
  tasks: AsyncTaskInfo[]
  onStop: (asyncTaskId: string) => void
}) {
  if (tasks.length === 0) {
    return null
  }
  return (
    <div className='flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/20 p-2'>
      <div className='px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
        Background work
      </div>
      {tasks.map((task) => (
        <div key={task.asyncTaskId} className='flex items-center gap-2 rounded px-1 py-0.5'>
          {task.state === 'paused' ? (
            <Pause className='size-3.5 shrink-0 text-muted-foreground' />
          ) : (
            <Loader2 className='size-3.5 shrink-0 animate-spin text-primary' />
          )}
          <div className='flex min-w-0 flex-col'>
            <span className='truncate text-xs font-medium text-foreground'>{task.name || task.taskType || 'Task'}</span>
            {task.description || task.summary ? (
              <span className='truncate text-[11px] text-muted-foreground'>{task.summary || task.description}</span>
            ) : null}
          </div>
          {task.canStop ? (
            <Button
              variant='ghost'
              size='sm'
              className='ml-auto h-6 gap-1 px-2 text-[11px]'
              onClick={() => onStop(task.asyncTaskId)}
            >
              <Square className='size-3' />
              Stop
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
