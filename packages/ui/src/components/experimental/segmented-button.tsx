'use client'

import { cn } from 'ui/lib/utils'

// Container heights match standard button heights (h-6, h-8, h-9, h-10)
// Inner buttons use h-full to fill the container
const sizeClasses = {
  xs: { container: 'text-xs h-6', button: 'px-2' },
  sm: { container: 'text-xs h-8', button: 'px-2.5' },
  default: { container: 'text-sm h-9', button: 'px-3' },
  lg: { container: 'text-sm h-10', button: 'px-4' },
} as const

type Size = keyof typeof sizeClasses

interface SegmentedButtonProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  size?: Size
  className?: string
}

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
          onClick={() => onChange(opt.value)}
          className={cn(
            'h-full rounded-[calc(var(--radius)-2px)] transition-colors cursor-pointer whitespace-nowrap',
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
