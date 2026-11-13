import * as React from 'react'
import { cn } from 'cn'
import { usePanelRef } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../resizable'
import { useIsMobile } from 'ui/hooks/use-mobile'

/** A resizable menu column's starting width and where the user's choice of width goes. */
export interface MenuResize {
  /**
   * The menu's width in pixels when the layout mounts, such as one `onWidthChange` reported earlier.
   * Omitted, the menu starts at the fixed column's width. The menu's minimum and maximum apply.
   */
  defaultWidth?: number
  /** Called with the menu's width in pixels after the user resized it, for the host to remember. */
  onWidthChange?: (width: number) => void
}

// The fixed column's width, MenuLayout's `md:w-96`.
const DEFAULT_WIDTH = '24rem'
// An entry's avatar or icon, a trailing button and padding take about 6rem; this leaves the
// entry's text about 10rem.
const MIN_WIDTH = '16rem'
// The panel beside the menu keeps at least half of the layout.
const MAX_WIDTH = '50%'
// The handle's hit area in pixels, centred on the boundary. For a finger it matches the handle's own
// box (`pointer-coarse:after:w-6`, 1.5rem), where the handle's `touch-action: none` keeps the
// browser from taking the touch for scrolling; past that box a touch starts on a panel's content,
// where the browser can take it. Wider, the box would also cover more of the panels' own controls.
const HANDLE_TARGET = { coarse: 24, fine: 10 }

interface ResizableMenuColumnsProps extends MenuResize {
  isOpened: boolean
  menu: React.ReactNode
  children: React.ReactNode
}

/**
 * MenuLayout's menu column and panel with a draggable boundary between them from md up, operated by
 * pointer, touch, or the keyboard on the focused handle (arrows, Home, End). Below md they are
 * arranged as in the fixed layout: one at a time at the full width, and no handle.
 *
 * The menu's content lays out its own scrolling; a panel's content wider than the panel scrolls
 * inside it.
 */
export function ResizableMenuColumns({
  isOpened,
  menu,
  defaultWidth,
  onWidthChange,
  children,
}: ResizableMenuColumnsProps) {
  // The hook's breakpoint is 768px, which is md (48rem) at the default root font size. It reads
  // false until mounted; before that nothing is resizable anyway.
  const isNarrow = useIsMobile()
  const groupRef = React.useRef<HTMLDivElement>(null)
  const menuRef = usePanelRef()
  const handleRef = React.useRef<HTMLDivElement>(null)
  // The width the menu is meant to have, as a size the library takes: the starting one, then each
  // one the user chooses with the handle.
  const menuWidth = React.useRef(defaultWidth === undefined ? DEFAULT_WIDTH : `${defaultWidth}px`)

  // The library also reports the layout on mount and whenever the window resizes the group, which
  // can clamp the menu to MAX_WIDTH; only a change made through the handle is the user's choice. The
  // library focuses the handle on a press within its hit area, so it has focus after a drag, a
  // double-click and a key press on it.
  const recordChosenWidth = () => {
    if (document.activeElement !== handleRef.current) return
    const percentage = menuRef.current?.getSize().asPercentage
    // The panels' pixel sizes are still the previous layout's here, before it renders, but together
    // they span the same width.
    const panels = groupRef.current?.querySelectorAll<HTMLElement>(':scope > [data-panel]') ?? []
    const panelsWidth = [...panels].reduce((sum, panel) => sum + panel.offsetWidth, 0)
    if (!percentage || !panelsWidth) return
    const width = Math.round((percentage / 100) * panelsWidth)
    menuWidth.current = `${width}px`
    onWidthChange?.(width)
  }

  // The library holds the layout in percentages of the group. It converts the menu's width for a
  // group that resizes, but not for one that grows while it mounts, as when the page is entered from
  // one with a sidebar this page lacks: a registration made at the narrower width is kept, so 24rem
  // of a narrower group becomes a wider menu. Whenever either panel's width changes other than
  // through the handle, the menu is put back to the width it is meant to have: the minimum and
  // maximum still apply, so a menu the maximum narrowed widens again once there is room, and when it
  // already has that width the call changes nothing.
  const keepMenuWidth = () => {
    if (isNarrow || document.activeElement === handleRef.current) return
    menuRef.current?.resize(menuWidth.current)
  }

  return (
    <ResizablePanelGroup
      orientation='horizontal'
      elementRef={groupRef}
      // The handle hidden below md measures 0 by 0 at the page's top-left corner, and the library pads
      // a hit area around it there unless the group is disabled.
      disabled={isNarrow}
      resizeTargetMinimumSize={HANDLE_TARGET}
      onLayoutChanged={recordChosenWidth}
      className={cn(
        'min-h-0 flex-1',
        // Below md: one column at a time at the full width, and the browser's own touch gestures
        // (the library hands only vertical panning to the browser). The library writes display,
        // flex-grow and touch-action inline, so these rules need !important.
        'max-md:touch-auto! max-md:[&>[data-panel]]:grow! max-md:[&>[data-hidden-below-md]]:hidden!',
      )}
    >
      <ResizablePanel
        panelRef={menuRef}
        // A bare number would be pixels and an unsuffixed string a percentage, so the unit is
        // always written. The server renders this size; the minimum and maximum apply once mounted.
        defaultSize={defaultWidth === undefined ? DEFAULT_WIDTH : `${defaultWidth}px`}
        minSize={MIN_WIDTH}
        maxSize={MAX_WIDTH}
        // When the window's width changes the menu keeps its own, as the fixed column does, and the
        // panel takes the difference.
        groupResizeBehavior='preserve-pixel-size'
        onResize={keepMenuWidth}
        data-hidden-below-md={isOpened ? '' : undefined}
        className='flex flex-col max-md:touch-auto!'
      >
        {menu}
      </ResizablePanel>
      <ResizableHandle
        withHandle
        elementRef={handleRef}
        aria-label='Resize menu'
        className='max-md:hidden pointer-coarse:after:w-6'
      />
      <ResizablePanel
        onResize={keepMenuWidth}
        data-hidden-below-md={isOpened ? undefined : ''}
        className='flex flex-col max-md:touch-auto!'
      >
        {children}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
