'use client'

import { cn } from 'cn'
import { type CSSProperties, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TitleBarProvider } from 'ui/layouts/title-bar'
import { TitleDragStrip } from 'ui/layouts/title-drag-handle'
import { Sidebar, SidebarContent, SidebarProvider, useSidebar } from 'ui/sidebar'

import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'
import { AppBottomNav } from '@/app/_shell/app-bottom-nav'
import { AppLauncherHost } from '@/app/_shell/app-launcher-host'
import { AppSidebarProvider, ProvideSheetClose, useAppSidebarSlot } from '@/app/_shell/app-sidebar'
import { AppTitleBar } from '@/app/_shell/app-title-bar'
import { AppViewportFrame } from '@/app/_shell/app-viewport'
import { CloseSheetOnNavigate } from '@/app/_shell/close-sheet-on-navigate'
import { RightSidebar } from '@/app/_shell/right-sidebar'
import { isRootPage } from '@/app/_shell/roots'
import { useTrackScreenStack } from '@/app/_shell/screen-stack'
import { useSpaceNavigation } from '@/app/_shell/space-navigation'

interface Props {
  spaces: SpaceSummary[]
  children: React.ReactNode
}

interface AppShellProps extends Props {
  /**
   * Draw the title bar and sidebars around the page. Off for an App's
   * full-page routes, which fill the window alone. The providers stay either
   * way, so an App that sends a title or sidebar content from such a page
   * sends it nowhere rather than failing.
   */
  chrome?: boolean
}

// The fixed-position sidebars below the bar are offset by its height. The bar grows a second row
// when a page sends it a toolbar, so the height is measured rather than fixed. The bottom
// navigation is measured the same way, and comes and goes with the page, so the element is
// followed through a callback ref; a height of 0 when it is gone.
function useMeasuredHeight() {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    if (!element) {
      setHeight(0)
      return
    }
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, height] as const
}

// The page runs under the bottom navigation, which floats over its bottom
// edge. Its scroll areas (the kit's ScrollArea, which every root page scrolls
// in) run on past their content by the pill's height, a spacer after the
// content so it adds to the page's own bottom padding: what scrolls passes
// beneath the pill and the last row still scrolls clear of it. Their
// scrollbar stops above the pill: pinned to the area's top and bottom, it is
// shortened by a margin once its height is left to those instead of the
// kit's full height.
const UNDER_BOTTOM_NAV = cn(
  '**:data-[slot=scroll-area-content]:after:h-(--bottom-nav-height) **:data-[slot=scroll-area-content]:after:flex-none',
  '**:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:h-auto **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:mb-(--bottom-nav-height)',
)

/**
 * The page beside the sidebars: the App's viewport (see AppViewport).
 *
 * An overlay sidebar takes no space from the row, so this box stays where it
 * is when the sidebar opens, and with it whatever fills the viewport. What
 * keeps the App's UI area out from under the sidebar is this box's padding,
 * which slides with the sidebar: the same width, duration and easing as the
 * sidebar's own slide. From the kit's mobile breakpoint down the sidebar is a
 * sheet, and the padding goes with it (`md:`, the breakpoint `useIsMobile`
 * reads).
 */
function ContentArea({
  overlaySidebar,
  bottomNav,
  bottomNavHeight,
  children,
}: {
  overlaySidebar: boolean
  bottomNav: React.ReactNode
  bottomNavHeight: number
  children: React.ReactNode
}) {
  const { open } = useSidebar()
  // The padding slides when the sidebar opens or closes, and only then. When
  // an App's overlay sidebar appears (the App mounting, a graph opened in place
  // of another) the padding is in place in the same frame, so a view framed
  // as the App opens, such as a graph fitted to its nodes, measures the UI
  // area the App keeps rather than one still sliding in.
  //
  // A transition starts from the style the browser last computed, so the
  // padding has to be computed without the transition before it goes on.
  // Reading the frame's width between the commit that adds the padding and
  // the one that adds the transition makes the browser compute it there.
  // Without the read, both commits can reach the browser's next style
  // computation together, and the padding slides in from 0.
  const frame = useRef<HTMLElement>(null)
  const [slides, setSlides] = useState(false)
  useLayoutEffect(() => {
    if (overlaySidebar) frame.current?.offsetWidth
    setSlides(overlaySidebar)
  }, [overlaySidebar])
  return (
    // Sized by the column, not by the measured bar height: that height is
    // only known after hydration, and a server-rendered page sized from it is
    // a full viewport plus the bar until then.
    <AppViewportFrame
      ref={frame}
      className={cn(
        'flex w-full min-w-0 flex-col',
        overlaySidebar && slides && 'transition-[padding-left] duration-200 ease-linear',
        overlaySidebar && open && 'md:pl-(--sidebar-width)',
        bottomNav && UNDER_BOTTOM_NAV,
      )}
      style={{ '--bottom-nav-height': `${bottomNavHeight}px` } as CSSProperties}
    >
      {/* Not positioned, so the frame stays what an AppViewport fills. */}
      <div className='flex min-h-0 w-full min-w-0 flex-1 flex-col'>{children}</div>
      {bottomNav}
    </AppViewportFrame>
  )
}

function Shell({ spaces, children }: Props) {
  const { hasContent, setNode, mode } = useAppSidebarSlot()
  const [barRef, barHeight] = useMeasuredHeight()
  const [bottomNavRef, bottomNavHeight] = useMeasuredHeight()
  const navigation = useSpaceNavigation()
  useTrackScreenStack(navigation.pathname)

  return (
    // Pinned to the viewport rather than sized in viewport units, so the page
    // cannot grow past the visible screen and the document never scrolls.
    // Sized in `dvh`, it was seen to scroll for a moment while loading in
    // Chrome on Android, moving the bottom navigation as it settled.
    <SidebarProvider
      className='fixed inset-0 min-h-0 flex-col'
      style={{ '--sidebar-width': '24rem', '--title-bar-height': `${barHeight}px` } as CSSProperties}
    >
      <CloseSheetOnNavigate />
      <ProvideSheetClose />
      <AppLauncherHost spaces={spaces} navigation={navigation}>
        {/* Its own layer in a view transition, so it stays put while the page slides (globals.css). */}
        <div ref={barRef} className='sticky top-0 z-20 [view-transition-name:app-title-bar]'>
          <Suspense fallback={null}>
            <AppTitleBar spaces={spaces} navigation={navigation} hasSidebar={hasContent} />
          </Suspense>
        </div>
        <div className='flex min-h-0 w-full flex-1'>
          {hasContent && (
            <Sidebar
              overlay={mode === 'overlay'}
              className='top-(--title-bar-height) h-[calc(100svh-var(--title-bar-height))]'
            >
              <SidebarContent ref={setNode} />
            </Sidebar>
          )}
          <ContentArea
            overlaySidebar={hasContent && mode === 'overlay'}
            bottomNavHeight={bottomNavHeight}
            bottomNav={
              isRootPage(navigation.pathname) && (
                // Over the page's bottom edge, letting presses through to the
                // page where the kit's bar does, beside the pill.
                <div
                  ref={bottomNavRef}
                  className='pointer-events-none absolute inset-x-0 bottom-0 z-10 [view-transition-name:app-bottom-nav] md:hidden'
                >
                  <Suspense fallback={null}>
                    <AppBottomNav navigation={navigation} />
                  </Suspense>
                </div>
              )
            }
          >
            {children}
          </ContentArea>
          <RightSidebar />
        </div>
      </AppLauncherHost>
    </SidebarProvider>
  )
}

export function AppShell({ spaces, children, chrome = true }: AppShellProps) {
  return (
    <TitleBarProvider>
      <AppSidebarProvider>
        {chrome ? (
          <Shell spaces={spaces}>{children}</Shell>
        ) : (
          // A full-page route has no title bar, so the drag strip stands in for
          // it in an installed app that draws into the window's title bar.
          <div className='fixed inset-0 flex min-w-0 flex-col'>
            <TitleDragStrip />
            <AppViewportFrame className='flex min-h-0 w-full min-w-0 flex-1 flex-col'>{children}</AppViewportFrame>
          </div>
        )}
      </AppSidebarProvider>
    </TitleBarProvider>
  )
}
