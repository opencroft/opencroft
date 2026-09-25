import {
  ChevronDown,
  Info,
  Lightbulb,
  type LucideIcon,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from 'ui/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from 'ui/components/ui/dropdown-menu'
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

/** A kind's own name and icon, for anything that offers the kinds as a choice. */
export function markdownCalloutKind(kind: MarkdownCalloutKind): { title: string; icon: LucideIcon } {
  return { title: TONES[kind].title, icon: TONES[kind].icon }
}

export interface MarkdownCalloutProps {
  /** What kind of aside this is. Decides the colour, the icon and the default title. */
  kind: MarkdownCalloutKind
  /** Replaces the kind's own name as the heading line. Empty counts as absent. */
  title?: string
  /** The body: prose, lists, code -- whatever the block holds. */
  children?: ReactNode
  /**
   * Makes the heading an input that reports each change. For an editor; the
   * kind's name is its placeholder, so an empty title still reads as the kind.
   */
  onTitleChange?: (title: string) => void
  /** Adds a switcher to the heading line that offers every kind. For an editor. */
  onKindChange?: (kind: MarkdownCalloutKind) => void
}

/**
 * A documentation aside: a note, a tip, something important, a warning or a
 * caution, set apart from the prose around it by a coloured rule and its icon.
 *
 * Given `onTitleChange` / `onKindChange` it is the same block made editable.
 * The heading line is then kept out of the surrounding editable text
 * (`contentEditable={false}`), so a rich-text editor hosting the block treats
 * it as controls rather than as prose to type into.
 */
export function MarkdownCallout({ kind, title, children, onTitleChange, onKindChange }: MarkdownCalloutProps) {
  const tone = TONES[kind]
  const Icon = tone.icon
  const editing = Boolean(onTitleChange || onKindChange)
  return (
    <div role='note' className={cn('my-2 rounded-r-md border-l-4 px-3 py-2', tone.box)}>
      <div
        contentEditable={editing ? false : undefined}
        // The heading is the block's own line, not prose: it keeps the kit's
        // leading wherever the surrounding prose sets a looser one.
        className={cn('flex items-center gap-1.5 font-medium leading-normal', tone.accent)}
      >
        <Icon className='size-4 shrink-0' aria-hidden />
        {onTitleChange ? (
          <input
            value={title ?? ''}
            placeholder={tone.title}
            onChange={(event) => onTitleChange(event.target.value)}
            aria-label='Callout title'
            className='min-w-0 flex-1 bg-transparent outline-none placeholder:text-current placeholder:opacity-60'
          />
        ) : (
          <span className='flex-1'>{title || tone.title}</span>
        )}
        {onKindChange ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type='button' variant='ghost' size='xs' className='text-current'>
                  {tone.title}
                  <ChevronDown />
                </Button>
              }
            />
            <DropdownMenuContent align='end'>
              {MARKDOWN_CALLOUT_KINDS.map((option) => {
                const OptionIcon = TONES[option].icon
                return (
                  <DropdownMenuItem key={option} onClick={() => onKindChange(option)}>
                    <OptionIcon className={TONES[option].accent} />
                    {TONES[option].title}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {/* The body sits flush with the frame: the frame's padding is the
          spacing, not the first and last paragraph's margins. Important,
          because a surrounding prose stylesheet (unlayered CSS) outranks a
          plain utility and would put its paragraph margins back. */}
      {children ? <div className='mt-1 [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!'>{children}</div> : null}
    </div>
  )
}
