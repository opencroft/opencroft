import { Flex, type FlexProps } from '@/components/ui/layout/flex';
import { cn } from '@/lib/utils';

type Side = 'top' | 'bottom' | 'left' | 'right';
type Variant = 'primary' | 'secondary' | 'background' | 'ghost';

interface StickySectionProps extends FlexProps {
  side?: Side;
  fade?: boolean;
  variant?: Variant;
}

const sideClasses: Record<Side, string> = {
  top: 'top-0 pb-0 w-full',
  bottom: 'bottom-0 pt-0 w-full',
  left: 'left-0 pr-0 h-full',
  right: 'right-0 pl-0 h-full',
};

const fadeClasses: Record<Side, string> = {
  top: 'inset-x-0 h-full top-0 bg-linear-to-b to-transparent from-background',
  bottom: 'inset-x-0 h-full bottom-0 bg-linear-to-t to-transparent from-background',
  left: 'inset-y-0 w-full left-0 bg-linear-to-r to-transparent from-background',
  right: 'inset-y-0 w-full right-0 bg-linear-to-l to-transparent from-background',
};

const variantClasses: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground rounded-xl shadow-lg p-1 gap-1',
  secondary: 'bg-secondary text-secondary-foreground rounded-xl shadow-lg p-1 gap-1',
  background: 'bg-background rounded-xl shadow-lg p-1 gap-1',
  ghost: '',
};

const isHorizontal = (side: Side) => side === 'left' || side === 'right';

export function StickySection({ side = 'top', fade, variant = 'ghost', className, children, ...props }: StickySectionProps) {
  const horizontal = isHorizontal(side);
  const content = variant !== 'ghost'
    ? <Flex row={!horizontal} className={variantClasses[variant]}>{children}</Flex>
    : children;

  return (
    <Flex
      row={horizontal}
      withSpacing
      className={cn(
        'sticky z-1',
        sideClasses[side],
        className
      )}
      {...props}>
      {fade && (
        <div className={cn("absolute pointer-events-none -z-1", fadeClasses[side])} />
      )}
      {content}
    </Flex>
  );
}
