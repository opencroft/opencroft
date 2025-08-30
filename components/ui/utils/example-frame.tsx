import { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Flex } from '../layout/flex';

type Size = 'fixed' | 'fit' | 'fill';

const sizes: Record<Size, string> = {
  fixed: 'grid-cols-[1fr_1fr_1fr] grid-rows-[1fr_1fr_1fr]',
  fit: 'grid-cols-[minmax(4rem,1fr)_auto_minmax(4rem,1fr)] grid-rows-[minmax(4rem,1fr)_auto_minmax(4rem,1fr)]',
  fill: 'grid-cols-[minmax(4rem,auto)_1fr_minmax(4rem,auto)] grid-rows-[minmax(4rem,auto)_1fr_minmax(4rem,auto)]',
};

export interface ExampleFrameProps {
  children: ReactNode;
  size?: Size;
  className?: string;
}

export function ExampleFrame({ children, size = 'fit', className }: ExampleFrameProps) {
  return (
    <div className={cn(`relative grid flex-1 ${sizes[size]} bg-background [--pattern-fg:var(--border)]`, className)}>

      <div className="relative col-start-1 row-start-1 col-span-full row-span-full bg-[repeating-linear-gradient(315deg,color-mix(in_srgb,var(--pattern-fg),transparent_30%)_0,color-mix(in_srgb,var(--pattern-fg),transparent_30%)_1px,transparent_0,transparent_50%)] bg-size-[10px_10px] bg-fixed" />

      <div className="relative col-start-1 row-start-2 col-span-full border-y border-y-(--pattern-fg)" />
      <div className="relative col-start-2 row-start-1 row-span-full border-x border-x-(--pattern-fg)" />

      <Flex className="col-start-2 row-start-2 bg-background z-1">
        {children}
      </Flex>
    </div>
  );
}
