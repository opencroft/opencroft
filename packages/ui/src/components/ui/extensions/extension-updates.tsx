'use client'

import { Check, ChevronRight, RefreshCw, TriangleAlert } from 'lucide-react'

import { Button } from 'ui/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'ui/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from 'ui/components/ui/item'
import { Progress, ProgressLabel, ProgressValue } from 'ui/components/ui/progress'
import { Spinner } from 'ui/components/ui/spinner'
import { cn } from 'cn'

/**
 * Where one extension's update stands. `available` and `failed` can be taken;
 * `queued` waits its turn in an Update all; `updated` is the outcome, kept on
 * screen until the host checks again.
 */
export type ExtensionUpdateState = 'available' | 'queued' | 'updating' | 'updated' | 'failed'

export interface ExtensionUpdate {
  id: string
  name: string
  /** Where it is now and where the update takes it, already formatted by the host: `v1.3.0`, `main · a1b2c3d`. */
  from: string
  to: string
  state: ExtensionUpdateState
  /** The outcome in words: why it failed, or what an update that landed still has to say. */
  message?: string
}

/** An extension with something newer that cannot take it, and why, in the sentence the list shows. */
export interface BlockedExtensionUpdate {
  id: string
  name: string
  reason: string
  /** What the host's tools said, verbatim, kept behind the reason: for whoever has to fix the cause. */
  detail?: string
}

export interface ExtensionUpdatesProps {
  updates: ExtensionUpdate[]
  blocked: BlockedExtensionUpdate[]
  /** A check is running. */
  checking?: boolean
  /** When the last check finished, already formatted by the host. */
  checkedLabel?: string
  /** How far an Update all has got. Given only while one runs. */
  progress?: { done: number; total: number }
  onCheck: () => void
  onUpdate: (id: string) => void
  onUpdateAll: () => void
  /** Opens an extension. Without it the names are plain text. */
  onOpen?: (id: string) => void
  className?: string
}

function canTake(state: ExtensionUpdateState): boolean {
  return state === 'available' || state === 'failed'
}

function ExtensionName({ id, name, onOpen }: { id: string; name: string; onOpen?: (id: string) => void }) {
  if (!onOpen) {
    return <span className='truncate'>{name}</span>
  }
  return (
    <button type='button' onClick={() => onOpen(id)} className='truncate text-left hover:underline'>
      {name}
    </button>
  )
}

// The outcome sits under the versions rather than in a toast: a run over
// several extensions ends with several outcomes, and the one that failed is
// the one somebody comes back to read.
function Outcome({ update }: { update: ExtensionUpdate }) {
  if (update.state === 'updated') {
    return (
      <span className='flex items-start gap-1 text-xs text-emerald-600 dark:text-emerald-400'>
        <Check className='mt-px size-3.5 shrink-0' />
        {update.message ?? 'Updated'}
      </span>
    )
  }
  if (update.state === 'failed') {
    return (
      <span className='flex items-start gap-1 text-xs text-destructive'>
        <TriangleAlert className='mt-px size-3.5 shrink-0' />
        <span className='min-w-0 break-words'>{update.message ?? 'The update failed.'}</span>
      </span>
    )
  }
  return null
}

// The reason is the sentence the list leads with. What the tools said stays
// one press away rather than inline: it is long, carries the host's paths and
// commands, and is written for whoever fixes the cause, not for the list.
function Detail({ detail }: { detail: string }) {
  return (
    <Collapsible className='group/detail'>
      <CollapsibleTrigger className='flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground'>
        <ChevronRight aria-hidden='true' className='size-3 shrink-0 transition-transform group-data-open/detail:rotate-90' />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className='mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground'>
          {detail}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function UpdateAction({
  update,
  running,
  onUpdate,
}: {
  update: ExtensionUpdate
  running: boolean
  onUpdate: (id: string) => void
}) {
  if (update.state === 'updating') {
    return (
      <span className='flex items-center gap-1.5 text-xs text-muted-foreground'>
        <Spinner className='size-3.5' />
        Updating…
      </span>
    )
  }
  if (update.state === 'queued') {
    return <span className='text-xs text-muted-foreground'>Queued</span>
  }
  if (!canTake(update.state)) {
    return null
  }
  return (
    <Button type='button' size='sm' variant='outline' disabled={running} onClick={() => onUpdate(update.id)}>
      {update.state === 'failed' ? 'Retry' : 'Update'}
    </Button>
  )
}

// Which extensions have an update, as one list, with what will happen visible
// before anything is pressed: each update says where it goes, the ones that
// cannot be taken say why, and Update all takes exactly the rows that offer an
// Update or a Retry. Updates run one at a time, so while a run is on every
// other Update waits for it.
export function ExtensionUpdates({
  updates,
  blocked,
  checking = false,
  checkedLabel,
  progress,
  onCheck,
  onUpdate,
  onUpdateAll,
  onOpen,
  className,
}: ExtensionUpdatesProps) {
  const running = updates.some((update) => update.state === 'queued' || update.state === 'updating')
  const takeable = updates.filter((update) => canTake(update.state)).length
  const nothingToShow = updates.length === 0 && blocked.length === 0

  return (
    <div data-slot='extension-updates' className={cn('flex w-full flex-col gap-4', className)}>
      <div className='flex items-start gap-3'>
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <h2 className='text-base font-semibold'>Updates</h2>
          {checkedLabel ? <span className='text-xs text-muted-foreground'>{checkedLabel}</span> : null}
        </div>
        <Button type='button' size='sm' variant='ghost' disabled={checking || running} onClick={onCheck}>
          <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
          Check again
        </Button>
        {updates.length > 0 ? (
          <Button type='button' size='sm' disabled={checking || running || takeable === 0} onClick={onUpdateAll}>
            Update all
          </Button>
        ) : null}
      </div>

      {progress ? (
        <Progress value={progress.total === 0 ? 0 : (progress.done / progress.total) * 100}>
          <ProgressLabel className='text-xs font-normal text-muted-foreground'>Updating</ProgressLabel>
          <ProgressValue className='text-xs'>{() => `${progress.done} of ${progress.total}`}</ProgressValue>
        </Progress>
      ) : null}

      {nothingToShow ? (
        checking ? (
          <span className='flex items-center gap-2 py-6 text-sm text-muted-foreground'>
            <Spinner className='size-4' />
            Checking for updates…
          </span>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Everything is up to date</EmptyTitle>
              <EmptyDescription>No extension has a newer version on its source.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      ) : null}

      {updates.length > 0 ? (
        <ItemGroup className='gap-2'>
          {updates.map((update) => (
            <Item key={update.id} variant='outline' size='sm'>
              <ItemContent className='min-w-0'>
                <ItemTitle className='min-w-0 max-w-full'>
                  <ExtensionName id={update.id} name={update.name} onOpen={onOpen} />
                </ItemTitle>
                <ItemDescription className='font-mono text-xs'>
                  {update.from} → {update.to}
                </ItemDescription>
                <Outcome update={update} />
              </ItemContent>
              <ItemActions>
                <UpdateAction update={update} running={running} onUpdate={onUpdate} />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : null}

      {blocked.length > 0 ? (
        <div className='flex flex-col gap-2'>
          <h3 className='text-[10px] uppercase tracking-wider text-muted-foreground'>Can’t update</h3>
          <ItemGroup className='gap-2'>
            {blocked.map((entry) => (
              <Item key={entry.id} variant='muted' size='sm'>
                <ItemContent className='min-w-0'>
                  <ItemTitle className='min-w-0 max-w-full'>
                    <ExtensionName id={entry.id} name={entry.name} onOpen={onOpen} />
                  </ItemTitle>
                  <ItemDescription className='text-xs'>{entry.reason}</ItemDescription>
                  {entry.detail ? <Detail detail={entry.detail} /> : null}
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </div>
      ) : null}
    </div>
  )
}
