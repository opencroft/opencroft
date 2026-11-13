import type { ComponentProps, ReactNode, RefObject } from 'react'
import { Button } from 'ui/components/ui/button'
import { Popover, PopoverContent } from 'ui/components/ui/popover'

/** What the popover sits against: an element, or a box the host measures (a text selection). */
export type MarkdownInlinePopoverAnchor = ComponentProps<typeof PopoverContent>['anchor']

export interface MarkdownInlinePopoverProps {
  /** What the popover edits, named for assistive technology: "Link", "Hint". */
  label: string
  open: boolean
  anchor: MarkdownInlinePopoverAnchor
  /** The fields. Enter in any of them applies. */
  children: ReactNode
  /** Apply, or Enter in a field. Offered only while `canApply` holds. */
  onApply: () => void
  canApply?: boolean
  /**
   * Cancel, Escape, a press outside or focus leaving. The popover moves focus
   * nowhere on its own. `returnFocus` says whether the host should put it back
   * where the editing started: yes for Cancel and Escape, no when the press or
   * the focus went somewhere else, which is where the reader wants to be.
   */
  onCancel: (returnFocus: boolean) => void
  /** Offered when the content already carries what the popover edits. */
  onRemove?: () => void
  /** The field focused on opening; the first one by default. */
  initialFocus?: RefObject<HTMLElement | null>
}

/**
 * The popover a markdown editor opens above the inline content it edits -- a
 * link, a hint: the fields the host passes, and Remove, Cancel and Apply under
 * them. Placed above the anchor, and flipped or shifted to stay on screen.
 * Pure presentation: what the fields hold and what applying does are the
 * host's.
 */
export function MarkdownInlinePopover({
  label,
  open,
  anchor,
  children,
  onApply,
  canApply = true,
  onCancel,
  onRemove,
  initialFocus,
}: MarkdownInlinePopoverProps) {
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (!next) {
          onCancel(details.reason === 'escape-key')
        }
      }}
    >
      <PopoverContent
        anchor={anchor}
        side='top'
        sideOffset={6}
        initialFocus={initialFocus ?? true}
        finalFocus={false}
        aria-label={label}
        className='w-80 max-w-[calc(100vw-1rem)] gap-3 p-3'
      >
        <form
          className='flex flex-col gap-3'
          onSubmit={(event) => {
            event.preventDefault()
            if (canApply) {
              onApply()
            }
          }}
        >
          {children}
          <div className='flex items-center gap-2'>
            {onRemove ? (
              <Button type='button' variant='ghost' size='sm' onClick={onRemove}>
                Remove
              </Button>
            ) : null}
            <div className='flex-1' />
            <Button type='button' variant='outline' size='sm' onClick={() => onCancel(true)}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={!canApply}>
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
