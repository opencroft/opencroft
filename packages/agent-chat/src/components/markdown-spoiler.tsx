import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

export interface MarkdownSpoilerProps {
  /** The line that stays visible while the body is hidden. Empty counts as absent. */
  summary?: string
  /** Start open rather than collapsed. */
  defaultOpen?: boolean
  /** What opening it reveals. */
  children?: ReactNode
}

/**
 * Content that is there on request: a long log, a full answer, the details
 * most readers skip.
 *
 * A native `details` element, so it opens without script.
 */
export function MarkdownSpoiler({ summary, defaultOpen = false, children }: MarkdownSpoilerProps) {
  return (
    <details open={defaultOpen} className='group my-2 rounded-md border'>
      <summary className='flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-medium select-none [&::-webkit-details-marker]:hidden'>
        <ChevronRight className='size-4 shrink-0 transition-transform group-open:rotate-90' aria-hidden />
        <span>{summary || 'Details'}</span>
      </summary>
      <div className='border-t px-3 py-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'>{children}</div>
    </details>
  )
}
