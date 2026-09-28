'use client'

import { type CSSProperties, Suspense, useEffect, useRef, useState } from 'react'
import { TitlebarProvider } from 'ui/layout/titlebar'
import { TitleBarProvider } from 'ui/layouts/title-bar'
import { Sidebar, SidebarContent, SidebarProvider } from 'ui/sidebar'

import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'
import { AppSidebarProvider, useAppSidebarSlot } from '@/app/_shell/app-sidebar'
import { AppTitleBar } from '@/app/_shell/app-title-bar'
import { CloseSheetOnNavigate } from '@/app/_shell/close-sheet-on-navigate'
import { RightSidebar } from '@/app/_shell/right-sidebar'

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

// Everything below the bar is offset by its height. The bar grows a second row
// when a page sends it a toolbar, so the height is measured rather than fixed.
function useMeasuredHeight() {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, height] as const
}

function Shell({ spaces, children }: Props) {
  const { hasContent, setNode, mode } = useAppSidebarSlot()
  const [barRef, barHeight] = useMeasuredHeight()

  return (
    <SidebarProvider
      className='flex-col'
      style={{ '--sidebar-width': '24rem', '--title-bar-height': `${barHeight}px` } as CSSProperties}
    >
      <CloseSheetOnNavigate />
      <div ref={barRef} className='sticky top-0 z-20'>
        <Suspense fallback={null}>
          <AppTitleBar spaces={spaces} hasSidebar={hasContent} />
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
        <main className='flex h-[calc(100dvh-var(--title-bar-height))] w-full min-w-0 flex-col'>{children}</main>
        <RightSidebar />
      </div>
    </SidebarProvider>
  )
}

export function AppShell({ spaces, children, chrome = true }: AppShellProps) {
  return (
    <TitlebarProvider>
      <TitleBarProvider>
        <AppSidebarProvider>
          {chrome ? (
            <Shell spaces={spaces}>{children}</Shell>
          ) : (
            <main className='flex h-dvh w-full min-w-0 flex-col'>{children}</main>
          )}
        </AppSidebarProvider>
      </TitleBarProvider>
    </TitlebarProvider>
  )
}
