'use client'

import { Link, useLocation } from '@tanstack/react-router'
import { MessagesSquare, Puzzle, SettingsIcon } from 'lucide-react'
import { Suspense } from 'react'
import { TitlebarProvider } from 'ui/layout/titlebar'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from 'ui/sidebar'
import { TooltipProvider } from 'ui/tooltip'
import { Wordmark } from 'ui/wordmark'

import { SpaceSidebarSection } from '@/app/_authed/(space)/_components/space-selector'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'
import { DevBuildBadge } from '@/app/_components/dev-build-badge'
import { RightSidebar } from '@/app/_shell/right-sidebar'
import { SignOutItem } from '@/app/(auth)/_components/sign-out-item'

interface Props {
  spaces: SpaceSummary[]
  children: React.ReactNode
}

function AppSidebar({ spaces }: { spaces: SpaceSummary[] }) {
  const pathname = useLocation({ select: (l) => l.pathname })

  return (
    <Sidebar collapsible='icon'>
      <SidebarHeader>
        {/*
          The lockup goes when the sidebar collapses to icons: at that width
          there is no room for a name, and a truncated wordmark is not a
          smaller wordmark. The trigger stays, so the row keeps the control
          that brings the sidebar back.
        */}
        <div className='flex items-center gap-2'>
          <Wordmark className='min-w-0 flex-1 group-data-[collapsible=icon]:hidden' />
          <SidebarTrigger />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SpaceSidebarSection spaces={spaces} />
        {/*
          A group chat belongs to its members, not to a space, so this section
          is not space-scoped. Routed rather than tab-based: a group chat is a
          place you navigate to, not a session you dock.
        */}
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to='/group-chats' />}
                tooltip='Chats'
                isActive={pathname.startsWith('/group-chats')}
              >
                <MessagesSquare />
                <span>Chats</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to='/extensions' />}
              tooltip='Extensions'
              isActive={pathname.startsWith('/extensions')}
            >
              <Puzzle />
              <span>Extensions</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to='/settings' />}
              tooltip='Settings'
              isActive={pathname.startsWith('/settings')}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SignOutItem />
        <DevBuildBadge />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

export function AppShell({ spaces, children }: Props) {
  return (
    <TitlebarProvider>
      <SidebarProvider style={{ '--sidebar-width': '24rem' } as React.CSSProperties}>
        {/*
          The tooltip provider is here for two reasons, and its position (inside
          SidebarProvider, around the Suspense boundary) is the second one.

          1. Shared tooltip timing. The Radix-era SidebarProvider rendered a
             TooltipProvider with no delay; the stock base-vega one renders none,
             so the menu-button tooltips would each wait Base UI's own delay.

          2. Hydration on a phone. SidebarProvider holds `isMobile`, which is
             false on the server and flips to true in an effect on a narrow
             screen. That state change re-renders SidebarProvider's own wrapper
             <div>; when the Suspense boundary below is still dehydrated at that
             moment and sits directly in that <div>, React hydrates it with the
             new value, renders the mobile Sheet over the server's desktop
             <div>, and throws "Hydration failed". A component between the
             <div> and the boundary bails out of that re-render (its props are
             unchanged), so the boundary hydrates with the server's value first
             and only then takes the update. The Radix-era sidebar never hit
             this: its state lived in a separate SidebarStateProvider, so the
             wrapper <div> did not re-render when `isMobile` changed.
        */}
        <TooltipProvider>
          <Suspense fallback={null}>
            <AppSidebar spaces={spaces} />
          </Suspense>
          <main className='flex flex-col w-full h-dvh'>{children}</main>
          <RightSidebar />
        </TooltipProvider>
      </SidebarProvider>
    </TitlebarProvider>
  )
}
