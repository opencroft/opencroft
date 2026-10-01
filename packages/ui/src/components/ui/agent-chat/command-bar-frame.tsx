'use client'

import type { ReactNode } from 'react'

import { NodeCard } from 'ui/components/ui/nodes/node-card'
import { cn } from 'cn'

export interface CommandBarFrameProps {
  /** The accent hairline and ring colour. Defaults to the primary accent every
   * chat footer uses; a surface with its own accent passes one. */
  accent?: string
  /** The composer. Anything -- this frame knows nothing about what is inside
   * it, which is what lets one frame serve three different composers. */
  children: ReactNode
  className?: string
}

// The card a composer sits in at the bottom of a chat.
//
// This exists because "roughly the same" is how the chat footers drifted apart.
// The 1:1 agent chat, a group chat's start-thread composer and a group-chat
// thread all draw the same footer, and each was drawing it from its own copy of
// the markup -- so the accent, the inset and the selected state were three
// independent decisions that only happened to agree. They stopped agreeing.
//
// The inset is the part worth naming: `px-2 py-1.5`, which is tighter than a
// panel's `px-4 py-3` and is what makes the composer read as a bar rather than
// as a card with a form in it. The agent command bar's controls carry their own
// padding, so a generous inset here reads as a gap around the bar instead of
// breathing room inside it.
//
// `items-start` rather than centred: a composer grows downward as it is typed
// into, and anything beside it -- a host's leading slot -- should stay put at
// the top rather than drift down the growing textarea.
export function CommandBarFrame({ accent = 'var(--primary)', children, className }: CommandBarFrameProps) {
  return (
    <NodeCard accent={accent} selected className={cn('pointer-events-auto', className)}>
      <div className='flex items-start gap-2 px-2 py-1.5'>{children}</div>
    </NodeCard>
  )
}
