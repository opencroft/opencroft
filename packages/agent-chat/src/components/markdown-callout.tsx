import { Info, Lightbulb, type LucideIcon, MessageSquareWarning, OctagonAlert, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from 'ui/lib/utils'

export type MarkdownCalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

interface Tone {
  icon: LucideIcon
  title: string
  box: string
  accent: string
}

// Listed out in full rather than built from the kind: a class name assembled at
// runtime is one no stylesheet scanner ever sees.
const TONES: Record<MarkdownCalloutKind, Tone> = {
  note: {
    icon: Info,
    title: 'Note',
    box: 'border-sky-500/60 bg-sky-500/5',
    accent: 'text-sky-700 dark:text-sky-400',
  },
  tip: {
    icon: Lightbulb,
    title: 'Tip',
    box: 'border-emerald-500/60 bg-emerald-500/5',
    accent: 'text-emerald-700 dark:text-emerald-400',
  },
  important: {
    icon: MessageSquareWarning,
    title: 'Important',
    box: 'border-violet-500/60 bg-violet-500/5',
    accent: 'text-violet-700 dark:text-violet-400',
  },
  warning: {
    icon: TriangleAlert,
    title: 'Warning',
    box: 'border-amber-500/60 bg-amber-500/5',
    accent: 'text-amber-700 dark:text-amber-400',
  },
  caution: {
    icon: OctagonAlert,
    title: 'Caution',
    box: 'border-destructive/60 bg-destructive/5',
    accent: 'text-destructive',
  },
}

/** Every kind, in the order a picker offers them. */
export const MARKDOWN_CALLOUT_KINDS = Object.keys(TONES) as MarkdownCalloutKind[]

export interface MarkdownCalloutProps {
  /** What kind of aside this is. Decides the colour, the icon and the default title. */
  kind: MarkdownCalloutKind
  /** Replaces the kind's own name as the heading line. Empty counts as absent. */
  title?: string
  /** The body: prose, lists, code -- whatever the block holds. */
  children?: ReactNode
}

/**
 * A documentation aside: a note, a tip, something important, a warning or a
 * caution, set apart from the prose around it by a coloured rule and its icon.
 */
export function MarkdownCallout({ kind, title, children }: MarkdownCalloutProps) {
  const tone = TONES[kind]
  const Icon = tone.icon
  return (
    <div role='note' className={cn('my-2 rounded-r-md border-l-4 px-3 py-2', tone.box)}>
      <div className={cn('flex items-center gap-1.5 font-medium', tone.accent)}>
        <Icon className='size-4 shrink-0' aria-hidden />
        <span>{title || tone.title}</span>
      </div>
      {children ? <div className='mt-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'>{children}</div> : null}
    </div>
  )
}
