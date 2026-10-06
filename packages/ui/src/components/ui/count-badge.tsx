import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'

// Overlaid on the control's corner rather than set beside its icon, so the
// control keeps the exact footprint of its neighbours whatever the count. The
// control it sits on must be `relative`, and carries the count in its own
// accessible name: the badge is decoration for the eye only.
const countBadgeVariants = cva(
  'absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full px-1 font-medium leading-none',
  {
    variants: {
      tone: {
        primary: 'bg-primary text-primary-foreground',
        muted: 'bg-muted text-muted-foreground ring-1 ring-border',
        // Ringed in the page's background, because it is worn by filled
        // controls and would otherwise run into their fill.
        destructive: 'bg-destructive text-white ring-2 ring-background',
      },
      size: {
        sm: 'h-4 min-w-4 text-[10px]',
        default: 'h-5 min-w-5 text-xs',
      },
    },
    defaultVariants: { tone: 'primary', size: 'sm' },
  },
)

export interface CountBadgeProps extends VariantProps<typeof countBadgeVariants> {
  count: number
  className?: string
}

/** The count on an icon control's corner. Nothing is drawn at zero: a zero badge says nothing a plain icon does not. */
export function CountBadge({ count, tone, size, className }: CountBadgeProps) {
  if (count <= 0) {
    return null
  }
  return (
    <span aria-hidden data-slot='count-badge' className={cn(countBadgeVariants({ tone, size }), className)}>
      {count}
    </span>
  )
}
