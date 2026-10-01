import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'

import { cn } from 'cn'

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
        // `isolate`: sticky parts inside (z-indexed headers, pinned columns) stack under the bars, not over them.
        className='peer/viewport isolate size-full rounded-[inherit] outline-none'
      >
        <ScrollAreaPrimitive.Content data-slot='scroll-area-content' className={cn('flex flex-col', innerClassName)}>
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
      {/* The viewport's keyboard focus ring, drawn inside the area's edge on a layer above the scrollbars.
          A ring outside the area is cut off wherever it sits flush in a container that clips overflow;
          one on the viewport itself is covered by the scrollbars, which overlay the viewport's edges;
          an inset shadow is covered by any content with a background. */}
      <span
        aria-hidden
        data-slot='scroll-area-focus-ring'
        className='pointer-events-none absolute inset-0 rounded-[inherit] outline-ring/50 peer-focus-visible/viewport:outline-3 peer-focus-visible/viewport:-outline-offset-3'
      />
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
