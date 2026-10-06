import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'

import * as React from 'react'

import { cn } from 'cn'

export type ScrollAreaScrollbars = 'vertical' | 'horizontal' | 'both'

interface ScrollAreaProps extends Omit<ScrollAreaPrimitive.Root.Props, 'className'> {
  className?: string
  innerClassName?: string
  // Lands on the viewport -- the element that actually scrolls -- not on the
  // root, so a host can read and drive `scrollTop` through it.
  ref?: React.Ref<HTMLDivElement>
  onScroll?: React.UIEventHandler<HTMLDivElement>
  // The bars drawn; each shows only while its axis overflows. The content
  // keeps the viewport's width (so `truncate` truncates, and wider children
  // overflow it and scroll), except in a horizontal-only strip, where it is
  // as wide as its row.
  scrollbars?: ScrollAreaScrollbars
  // Classes for the viewport: snap, overscroll, touch-action, or a height
  // limit when the root has no bounded height (a menu's `max-h-*`).
  viewportClassName?: string
  // Other props for the viewport, for a scroller that is itself a widget:
  // role, aria-label, tabIndex, key and context-menu handlers.
  viewportProps?: Omit<ScrollAreaPrimitive.Viewport.Props, 'className' | 'ref' | 'onScroll' | 'children'>
}

// The viewport holds exactly ONE wrapper, and it is this component's own: the
// Base UI content part, drawn as a flex column and carrying `innerClassName`.
// (Radix used to insert a `display: table` div of its own between the viewport
// and this wrapper; Base UI inserts nothing, so there is no second layer to
// force into shape any more.) A host that needs the content to fill the
// viewport's height -- to bottom-anchor a short conversation, say -- passes
// `innerClassName='min-h-full'`; the wrapper is also reachable as
// `[data-slot=scroll-area-content]`.
export function ScrollArea({
  className,
  innerClassName,
  children,
  ref,
  onScroll,
  scrollbars = 'vertical',
  viewportClassName,
  viewportProps,
  ...props
}: ScrollAreaProps) {
  return (
    // A flex column whose viewport takes the height left to it, so the area scrolls in a box of fixed
    // height, as a flex item of a box with only a max-height (a popover), and grows with an auto height.
    <ScrollAreaPrimitive.Root data-slot='scroll-area' className={cn('relative flex min-h-0 flex-col', className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        {...viewportProps}
        ref={ref}
        onScroll={onScroll}
        data-slot='scroll-area-viewport'
        className={cn(
          // `isolate`: sticky parts inside (z-indexed headers, pinned columns) stack under the bars, not over them.
          // `relative`: the viewport is the containing block of what is positioned inside it. Without it an
          // absolutely positioned descendant (an `sr-only` label, say) is placed against the root, outside the
          // scrolling box: it is not clipped, does not scroll, and overflows whatever holds the area, which
          // then scrolls as a second scroller beside this one.
          'peer/viewport relative isolate min-h-0 w-full flex-auto rounded-[inherit] outline-none',
          viewportClassName,
        )}
      >
        <ScrollAreaPrimitive.Content
          data-slot='scroll-area-content'
          className={cn('flex flex-col', innerClassName)}
          // Base UI sizes the content `min-width: fit-content`, which lets one long unbreakable line widen it.
          style={scrollbars === 'horizontal' ? undefined : { minWidth: 0 }}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      {scrollbars !== 'horizontal' ? <ScrollBar /> : null}
      {scrollbars !== 'vertical' ? <ScrollBar orientation='horizontal' /> : null}
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
