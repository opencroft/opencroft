'use client'

import { cn } from 'cn'

// Track heights match the standard button heights (h-6, h-8, h-9, h-10) so this
// sits in a toolbar beside a button without either looking wrong. The inner
// buttons are h-full and take only horizontal padding, so the track decides the
// height and the options cannot disagree with it.
const sizeClasses = {
  xs: { container: 'text-xs h-6', button: 'px-2' },
  sm: { container: 'text-xs h-8', button: 'px-2.5' },
  default: { container: 'text-sm h-9', button: 'px-3' },
  lg: { container: 'text-sm h-10', button: 'px-4' },
} as const

type Size = keyof typeof sizeClasses

export interface SegmentedButtonProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  size?: Size
  className?: string
}

// One bordered track holding mutually exclusive options; the selected one lifts
// onto the background colour rather than being outlined, so the set reads as a
// single control with a position rather than as several buttons.
//
// Controlled, and deliberately so: which option is chosen is nearly always
// something the surrounding view also needs to know.
export function SegmentedButton<T extends string>({
  value,
  onChange,
  options,
  size = 'default',
  className,
}: SegmentedButtonProps<T>) {
  const s = sizeClasses[size]
  return (
    <div className={cn('flex items-center gap-0.5 rounded-md border p-0.5 bg-muted', s.container, className)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type='button'
          onClick={() => onChange(opt.value)}
          // The inner radius is the track's radius less its padding, so the
          // corners nest instead of sitting concentric. Written as an inline
          // style rather than an arbitrary Tailwind class, which is generated
          // for no build and would leave the corners square.
          style={{ borderRadius: 'calc(var(--radius) - 2px)' }}
          className={cn(
            'h-full transition-colors cursor-pointer whitespace-nowrap',
            s.button,
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
