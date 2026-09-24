import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'

import { cn } from 'ui/lib/utils'

interface ScrollAreaProps extends Omit<ScrollAreaPrimitive.Root.Props, 'className'> {
  className?: string
  innerClassName?: string
  // Lands on the viewport -- the element that actually scrolls -- not on the
  // root, so a host can read and drive `scrollTop` through it.
  ref?: React.Ref<HTMLDivElement>
  onScroll?: React.UIEventHandler<HTMLDivElement>
}

// The viewport holds exactly ONE wrapper, and it is this component's own: the
// Base UI content part, drawn as a flex column and carrying `innerClassName`.
// (Radix used to insert a `display: table` div of its own between the viewport
// and this wrapper; Base UI inserts nothing, so there is no second layer to
// force into shape any more.) A host that needs the content to fill the
// viewport's height -- to bottom-anchor a short conversation, say -- passes
// `innerClassName='min-h-full'`; the wrapper is also reachable as
// `[data-slot=scroll-area-content]`.
export function ScrollArea({ className, innerClassName, children, ref, onScroll, ...props }: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root data-slot='scroll-area' className={cn('relative min-h-0', className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        ref={ref}
        onScroll={onScroll}
        data-slot='scroll-area-viewport'
        className='focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1'
      >
        <ScrollAreaPrimitive.Content data-slot='scroll-area-content' className={cn('flex flex-col', innerClassName)}>
          {children}
        </ScrollAreaPrimitive.Content>
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
}: Omit<ScrollAreaPrimitive.Scrollbar.Props, 'className'> & { className?: string }) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot='scroll-area-scrollbar'
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb data-slot='scroll-area-thumb' className='relative flex-1 rounded-full bg-border' />
    </ScrollAreaPrimitive.Scrollbar>
  )
}
