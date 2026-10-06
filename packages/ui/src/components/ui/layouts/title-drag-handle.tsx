import type { ComponentProps } from 'react'

import { cn } from 'cn'

// An installed app in window-controls-overlay mode draws into the window's own
// title bar, and the window then drags only by what is marked as a drag region.
// A drag region swallows every press inside it, so the region is this empty
// element alone and never an area with controls carved out of it. The classes
// are spelled out in full because the stylesheet is generated from the source
// text.
const DRAG =
  '[@media(display-mode:window-controls-overlay)]:[-webkit-app-region:drag] [@media(display-mode:window-controls-overlay)]:[app-region:drag]'
const STRIP =
  'hidden w-full flex-none [@media(display-mode:window-controls-overlay)]:block [@media(display-mode:window-controls-overlay)]:h-[env(titlebar-area-height,0px)]'

/**
 * Fills the free width of a title bar's row and drags the window by it. Put
 * nothing inside. In any other display mode it is a plain spacer.
 */
export function TitleDragHandle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden
      data-slot='title-drag-handle'
      className={cn('min-w-0 flex-1 self-stretch', DRAG, className)}
      {...props}
    />
  )
}

/**
 * The handle as a strip across the top of a page that has no title bar, as
 * tall as the window's title bar area, so the page starts below the window
 * buttons and the window still has something to drag by. It is drawn only in
 * that display mode; anywhere else the page starts at the top as before.
 */
export function TitleDragStrip({ className, ...props }: ComponentProps<'div'>) {
  return <TitleDragHandle className={cn(STRIP, className)} {...props} />
}
