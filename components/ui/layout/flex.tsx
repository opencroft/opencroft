import { cn } from '@/lib/utils';

export type FlexDirection = 'row' | 'row-reverse' | 'col' | 'col-reverse';
export type JustifyContent = 'start' | 'end' | 'end-safe' | 'center' | 'center-safe' | 'between' | 'around' | 'evenly' | 'stretch' | 'baseline' | 'normal';
export type AlignItems = 'start' | 'end' | 'end-safe' | 'center' | 'center-safe' | 'baseline' | 'baseline-last' | 'stretch';

export interface FlexProps extends React.ComponentProps<"div"> {
  justify?: JustifyContent;
  align?: AlignItems;
  row?: boolean;
  reversed?: boolean;
  withPadding?: boolean;
  withGaps?: boolean;
  withSpacing?: boolean;
  expanded?: boolean;
  className?: string;
}

export function Flex({
  justify = 'normal',
  align = 'stretch',
  row,
  reversed,
  withPadding,
  withGaps,
  withSpacing,
  expanded,
  className,
  ...props
}: FlexProps) {
  return (
    <div
      className={cn(
        'flex',
        `${row ? 'flex-row' : 'flex-col'}${reversed ? '-reverse' : ''}`,
        `justify-${justify}`,
        `items-${align}`,
        (withPadding || withSpacing) && 'p-(--flex-padding)',
        (withGaps || withSpacing) && 'gap-(--flex-gap)',
        expanded && 'flex-1',
        className
      )}
      {...props}
    />
  );
}
