import { cva, type VariantProps } from 'class-variance-authority';
import { type ReactNode } from 'react';

import { Flex } from '@/components/ui/layout/flex';
import { cn } from '@/lib/utils';

export const chainDotVariants = cva('size-2 rounded-full', {
  variants: {
    variant: {
      default: 'bg-muted-foreground',
      success: 'bg-green-500',
      destructive: 'bg-destructive',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

export type ChainDotVariant = NonNullable<VariantProps<typeof chainDotVariants>['variant']>;

export function ChainDot({ variant }: { variant?: ChainDotVariant }) {
  return <div className={chainDotVariants({ variant })} />;
}

export type ChainedAlign = 'center' | 'start';

export interface ChainedProps {
  marker: ReactNode;
  lineAbove: boolean;
  lineBelow: boolean;
  align?: ChainedAlign;
  children: ReactNode;
}

export function Chained({ marker, lineAbove, lineBelow, align = 'center', children }: ChainedProps) {
  const top = align === 'start';
  return (
    <Flex row className='min-h-8 min-w-0 gap-2'>
      <Flex align='center' className='w-8 shrink-0'>
        <div className={cn('w-px', !top && 'flex-1', lineAbove && 'bg-secondary')} />
        <div className='shrink-0'>{marker}</div>
        <div className={cn('w-px flex-1', lineBelow && 'bg-secondary')} />
      </Flex>
      <div className={cn('flex-1 min-w-0 py-2', top ? 'self-start' : 'self-center')}>{children}</div>
    </Flex>
  );
}
