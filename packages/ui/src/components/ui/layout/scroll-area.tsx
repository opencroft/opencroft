import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'

import { cn } from 'ui/lib/utils'

interface ScrollAreaProps extends React.ComponentProps<typeof ScrollAreaPrimitive.Root> {
  innerClassName?: string
  ref?: React.Ref<HTMLDivElement>
  onScroll?: React.UIEventHandler<HTMLDivElement>
}

export function ScrollArea({ className, innerClassName, children, ref, onScroll, ...props }: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root data-slot='scroll-area' className={cn('relative min-h-0', className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        ref={ref}
        onScroll={onScroll}
        data-slot='scroll-area-viewport'
        className='focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1'
      >
        <div className={cn('flex flex-col', innerClassName)}>{children}</div>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

// The scrollbar is defined here rather than borrowed from the shadcn primitive
// of the same name, and that is load-bearing: a borrowed import cannot survive
// either surface this file ships to. The preview pool resolves imports by
// basename, so a specifier naming the primitive lands back on this very file;
// and the installer composes this component's own path for that specifier, so
// an installed copy would import the symbol from itself. Styling matches the
// primitive's scrollbar exactly -- if that changes upstream, this copy is
// where the drift will be.
export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot='scroll-area-scrollbar'
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot='scroll-area-thumb'
        className='relative flex-1 rounded-full bg-border'
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}
