import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

export interface MarkdownSpoilerProps {
  /** The line that stays visible while the body is hidden. Empty counts as absent. */
  summary?: string
  /** Start open rather than collapsed. */
  defaultOpen?: boolean
  /** What opening it reveals. */
  children?: ReactNode
  /**
   * Makes it the editable form of the block: always open, the summary an
   * input reporting each change. For an editor.
   */
  onSummaryChange?: (summary: string) => void
}

const BOX = 'group my-2 rounded-md border'
// The summary is the block's own line, not prose: it keeps the kit's leading
// wherever the surrounding prose sets a looser one.
const SUMMARY = 'flex items-center gap-1.5 px-3 py-2 font-medium leading-normal'
// The body sits flush with the frame: its padding is the spacing, not the first
// and last paragraph's margins.
const BODY = 'border-t px-3 py-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'
const DEFAULT_SUMMARY = 'Details'

/**
 * Content that is there on request: a long log, a full answer, the details
 * most readers skip.
 *
 * A native `details` element, so it opens without script.
 *
 * Given `onSummaryChange` it is the same block made editable: an always-open
 * box rather than `details`, since while it is being edited its body is always
 * shown, and an input inside a `summary` would sit on the very control that
 * collapses the block. The summary line is then kept out of the surrounding
 * editable text (`contentEditable={false}`), so a rich-text editor hosting the
 * block treats it as a control rather than as prose to type into.
 */
export function MarkdownSpoiler({ summary, defaultOpen = false, children, onSummaryChange }: MarkdownSpoilerProps) {
  if (onSummaryChange) {
    return (
      <div className={BOX}>
        <div contentEditable={false} className={SUMMARY}>
          <ChevronDown className='size-4 shrink-0' aria-hidden />
          <input
            value={summary ?? ''}
            placeholder={DEFAULT_SUMMARY}
            onChange={(event) => onSummaryChange(event.target.value)}
            aria-label='Spoiler summary'
            className='min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground'
          />
        </div>
        <div className={BODY}>{children}</div>
      </div>
    )
  }
  return (
    <details open={defaultOpen} className={BOX}>
      <summary className={`${SUMMARY} cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden`}>
        <ChevronRight className='size-4 shrink-0 transition-transform group-open:rotate-90' aria-hidden />
        <span>{summary || DEFAULT_SUMMARY}</span>
      </summary>
      <div className={BODY}>{children}</div>
    </details>
  )
}
