import type { ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'
import { cn } from 'cn'

/**
 * How hinted content is marked, in a page and in the editor alike: a dotted
 * line under it in the muted colour. A border rather than a text underline,
 * which an icon does not get.
 */
export const MARKDOWN_HINT_MARK_CLASS = 'border-b border-dotted border-muted-foreground'

export interface MarkdownHintProps {
  /** The note shown over the content. */
  text: string
  /** The content the hint sits on: any inline content, formatted text and icons included. */
  children: ReactNode
  className?: string
}

/**
 * A note over inline content. It is what `markdown` renders a
 * `:hint[content]{text="…"}` directive as.
 *
 * One popover serves every kind of pointer: a mouse opens it by hovering, a
 * tap opens it and a second tap or one outside closes it, and from the
 * keyboard the content is a button that Enter or Space toggles and Escape
 * closes. The note wraps, and the popover flips or shifts to stay on screen.
 */
export function MarkdownHint({ text, children, className }: MarkdownHintProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        nativeButton={false}
        render={<span />}
        className={cn(
          MARKDOWN_HINT_MARK_CLASS,
          'cursor-help rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          className,
        )}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side='top'
        className='w-auto max-w-[min(20rem,calc(100vw-1rem))] gap-0 px-3 py-2 break-words whitespace-normal'
      >
        {text}
      </PopoverContent>
    </Popover>
  )
}
