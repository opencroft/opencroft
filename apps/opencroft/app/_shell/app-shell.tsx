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
              <SidebarMenuButton asChild tooltip='Chats' isActive={pathname.startsWith('/group-chats')}>
                <Link to='/group-chats'>
                  <MessagesSquare />
                  <span>Chats</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip='Extensions' isActive={pathname.startsWith('/extensions')}>
              <Link to='/extensions'>
                <Puzzle />
                <span>Extensions</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip='Settings' isActive={pathname.startsWith('/settings')}>
              <Link to='/settings'>
                <SettingsIcon />
                <span>Settings</span>
              </Link>
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
        <Suspense fallback={null}>
          <AppSidebar spaces={spaces} />
        </Suspense>
        <main className='flex flex-col w-full h-dvh'>{children}</main>
        <RightSidebar />
      </SidebarProvider>
    </TitlebarProvider>
  )
}
