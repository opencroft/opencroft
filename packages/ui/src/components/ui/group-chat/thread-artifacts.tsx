'use client'

import { FileText, X } from 'lucide-react'
import { Markdown } from 'agent-chat/components/markdown'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A note an agent left on a thread.
 *
 * `content` is markdown, rendered the same way the conversation's own messages
 * are — an artifact is the agent still talking, in the same voice, about work it
 * just did.
 */
export interface Artifact {
  id: string
  title: string
  /** Markdown. */
  content: string
  /** Shown beside the title when present. Already formatted by the host. */
  updatedLabel?: string
}

export interface ArtifactStripProps {
  artifacts: Artifact[]
  /** The artifact currently open, if any. */
  openId?: string
  onOpen: (id: string) => void
  className?: string
}

/**
 * The artifacts on a thread, as a strip for its header.
 *
 * Titles rather than a single count: a thread's artifacts are few and named, so
 * showing what they ARE costs the same row as saying how many there are, and
 * saves a press to find out. A press opens one; the host decides where it lands.
 *
 * Renders nothing at all when there are none — a thread earns artifacts by
 * having work done in it, and an empty affordance would advertise a feature to
 * every thread that has never used one.
 *
 * Scrolls rather than wraps, so a header stays one row however many there are.
 */
export function ArtifactStrip({ artifacts, openId, onOpen, className }: ArtifactStripProps) {
  if (artifacts.length === 0) {
    return null
  }
  return (
    <div className={cn('flex min-w-0 items-center gap-1 overflow-x-auto', className)}>
      {artifacts.map((artifact) => {
        const open = artifact.id === openId
        return (
          <Button
            key={artifact.id}
            type='button'
            size='sm'
            variant={open ? 'secondary' : 'ghost'}
            className='h-7 shrink-0 gap-1.5 px-2'
            onClick={() => onOpen(artifact.id)}
            title={artifact.title}
          >
            <FileText className='size-3.5 text-muted-foreground' />
            <span className='max-w-40 truncate text-xs'>{artifact.title}</span>
          </Button>
        )
      })}
    </div>
  )
}

export interface ArtifactPanelProps {
  artifact: Artifact
  /** Omit to render without a close affordance, e.g. in a pinned column. */
  onClose?: () => void
  className?: string
}

/**
 * One artifact, opened.
 *
 * Read-only on purpose. An agent revises these on its next iteration, so an
 * edit offered here would be a change waiting to be overwritten without warning
 * — and a note the reader half-owns is worse than one they plainly do not.
 *
 * Fills the height it is given and scrolls its own body, so a long note costs
 * the column no more room than a short one. WHERE it sits — a right sidebar, a
 * drawer on a narrow screen — is the host's layout decision, not this
 * component's: it renders the panel and nothing around it.
 */
export function ArtifactPanel({ artifact, onClose, className }: ArtifactPanelProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className='flex items-start gap-2 border-b px-3 py-2'>
        <FileText className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
        <div className='min-w-0 flex-1'>
          {/* Wraps rather than truncates: this is the note's name and the only
              thing identifying which one is open. */}
          <div className='text-sm font-medium'>{artifact.title}</div>
          {artifact.updatedLabel ? <div className='text-xs text-muted-foreground'>{artifact.updatedLabel}</div> : null}
        </div>
        {onClose ? (
          <Button type='button' size='icon' variant='ghost' className='size-7 shrink-0' onClick={onClose} title='Close'>
            <X className='size-4' />
          </Button>
        ) : null}
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto px-3 py-3'>
        <Markdown text={artifact.content} />
      </div>
    </div>
  )
}
