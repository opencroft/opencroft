'use client'

import { ArchiveRestore } from 'lucide-react'

import { Button } from '../button'

export interface ArchivedThreadNoticeProps {
  /** Bring the thread back to the active list. */
  onUnarchive: () => void
  /** The unarchive request is in flight -- disables the button and swaps its label. */
  pending?: boolean
  /** A refused or failed unarchive, in the server's own words. */
  error?: string
}

// Stands exactly where the composer stands -- the host wraps it in the same
// command-bar frame a live composer sits in, so an archived thread reads as
// an ordinary one with its input traded for the single thing left to do.
export function ArchivedThreadNotice({ onUnarchive, pending = false, error }: ArchivedThreadNoticeProps) {
  return (
    <div className='flex w-full flex-col gap-2'>
      <div className='flex flex-wrap items-center gap-3'>
        <ArchiveRestore className='size-4 shrink-0 text-muted-foreground' aria-hidden />
        <p className='flex-1 text-sm text-muted-foreground'>This thread is archived. Unarchive it to write.</p>
        <Button type='button' size='sm' variant='outline' onClick={onUnarchive} disabled={pending}>
          {pending ? 'Unarchiving…' : 'Unarchive'}
        </Button>
      </div>
      {error ? <p className='text-sm text-destructive'>{error}</p> : null}
    </div>
  )
}
