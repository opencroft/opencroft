'use client'

import { FileText } from 'lucide-react'
import { Markdown } from 'agent-chat/components/markdown'
import { Button } from 'ui/components/ui/button'
import { CountBadge } from 'ui/components/ui/count-badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'
import { cn } from 'cn'

import { LIST_ROW_SECONDARY_CLASS, LIST_ROW_TITLE_CLASS } from '../utils/list-row'

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
  /** Shown under the title when present. Already formatted by the host. */
  updatedLabel?: string
}

export interface ArtifactMenuProps {
  artifacts: Artifact[]
  /** The artifact currently open, if any; marked in the list. */
  openId?: string
  onOpen: (id: string) => void
  /** The button's size, matching the header's other icon controls: `icon` in
   * a pointer header, `icon-sm` on a touch cover. */
  size?: 'icon' | 'icon-sm'
  className?: string
}

/**
 * The artifacts on a thread, as one icon control in the thread's header -- the
 * only way into them, so they cost the header one button rather than a row.
 *
 * The count sits on the button's corner, so it keeps the footprint of the icon
 * buttons beside it whatever the count; the titles are one press away, in the
 * order the host lists them, with the open one checked. Renders nothing at all
 * when there are none -- a thread earns artifacts by having work done in it,
 * and an empty affordance would advertise a feature to every thread that has
 * never used one.
 */
export function ArtifactMenu({ artifacts, openId, onOpen, size = 'icon', className }: ArtifactMenuProps) {
  if (artifacts.length === 0) {
    return null
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type='button'
            variant='ghost'
            size={size}
            aria-label='Artifacts'
            title='Artifacts'
            className={cn('relative', className)}
          />
        }
      >
        <FileText />
        <CountBadge count={artifacts.length} tone='muted' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-64'>
        {/* A radio group because exactly one note is open at a time, and the
            check is how the list says which. Choosing the one already open
            changes nothing, which is what a reader pressing it expects.
            `closeOnClick` because choosing one opens it: a radio item stays
            open on a press by default, the way a setting toggled in place
            does, and this menu is left the moment a note is picked. */}
        <DropdownMenuRadioGroup value={openId ?? ''} onValueChange={(value) => onOpen(value as string)}>
          {artifacts.map((artifact) => (
            <DropdownMenuRadioItem key={artifact.id} value={artifact.id} closeOnClick>
              <div className='flex min-w-0 flex-col'>
                <span className='truncate'>{artifact.title}</span>
                {artifact.updatedLabel ? (
                  <span className='truncate text-xs text-muted-foreground'>{artifact.updatedLabel}</span>
                ) : null}
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface ArtifactPartProps {
  artifact: Artifact
  className?: string
}

/**
 * An open artifact's name, as content for a header row the host owns.
 *
 * One line that truncates, with the whole name on hover: the row has a fixed
 * height shared with the conversation's header beside it, so a name that
 * wrapped would push the two out of line. `updatedLabel`, when the host gives
 * one, is the second line of the same two-line stack the thread's agent
 * cluster draws, in the same list-row styles -- so the two headers read as one.
 */
export function ArtifactTitle({ artifact, className }: ArtifactPartProps) {
  return (
    <span className={cn('flex min-w-0 flex-col overflow-hidden leading-tight', className)} title={artifact.title}>
      <span className={LIST_ROW_TITLE_CLASS}>{artifact.title}</span>
      {artifact.updatedLabel ? <span className={LIST_ROW_SECONDARY_CLASS}>{artifact.updatedLabel}</span> : null}
    </span>
  )
}

/**
 * An open artifact's content: fills the height it is given and scrolls itself,
 * so a long note costs its pane no more room than a short one.
 *
 * Read-only on purpose. An agent revises these on its next iteration, so an
 * edit offered here would be a change waiting to be overwritten without warning
 * — and a note the reader half-owns is worse than one they plainly do not.
 */
export function ArtifactBody({ artifact, className }: ArtifactPartProps) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto px-3 py-3', className)}>
      <Markdown text={artifact.content} />
    </div>
  )
}
