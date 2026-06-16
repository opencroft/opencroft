import { cn } from '@/lib/utils';

type ColorVariant = 'primary' | 'secondary' | 'destructive';

export interface TypingDotsProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: ColorVariant;
}

export function TypingDots({ className, size = 'md', variant }: TypingDotsProps) {
  const sizeClasses = {
    sm: 'w-1.5 h-1.5',
    md: 'w-2 h-2',
    lg: 'w-3 h-3',
  };

  const variantClasses = variant ? {
    primary: 'bg-primary',
    secondary: 'bg-secondary',
    destructive: 'bg-destructive',
  }[variant] : 'bg-current';

  const dotSize = sizeClasses[size];

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <div
        className={cn(
          'rounded-full animate-bounce',
          dotSize,
          variantClasses
        )}
        style={{ animationDelay: '0ms', animationDuration: '1s' }}
      />
      <div
        className={cn(
          'rounded-full animate-bounce',
          dotSize,
          variantClasses
        )}
        style={{ animationDelay: '150ms', animationDuration: '1s' }}
      />
      <div
        className={cn(
          'rounded-full animate-bounce',
          dotSize,
          variantClasses
        )}
        style={{ animationDelay: '300ms', animationDuration: '1s' }}
      />
    </div>
  );
}
