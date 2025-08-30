import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

type StatusVariant = 'primary' | 'secondary' | 'muted' | 'accent' | 'success' | 'warning' | 'destructive';

export interface StatusIndicatorProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'className'> {
  variant?: StatusVariant;
  className?: string;
}

export const StatusIndicator = ({
  variant,
  className,
  ...props
}: StatusIndicatorProps) => (
  <span className={cn('relative flex h-2 w-2', 'group', variant, className)} {...props}>
    <span
      className={cn(
        'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
        'group-[.primary]:bg-primary',
        'group-[.secondary]:bg-secondary',
        'group-[.muted]:bg-muted',
        'group-[.accent]:bg-accent',
        'group-[.success]:bg-green-500',
        'group-[.warning]:bg-amber-500',
        'group-[.destructive]:bg-destructive',
      )}
    />
    <span
      className={cn(
        'relative inline-flex h-2 w-2 rounded-full',
        'group-[.primary]:bg-primary',
        'group-[.secondary]:bg-secondary',
        'group-[.muted]:bg-muted',
        'group-[.accent]:bg-accent',
        'group-[.success]:bg-green-500',
        'group-[.warning]:bg-amber-500',
        'group-[.destructive]:bg-destructive',
      )}
    />
  </span>
);

export default StatusIndicator;
