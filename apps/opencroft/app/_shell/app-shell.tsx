'use client'

import type { DashboardMeta } from '@opencroft/dashboards'
import { DashboardsSidebarSection } from '@opencroft/dashboards/client'
import { Link, useLocation } from '@tanstack/react-router'
import { ChevronRight, MessagesSquare, Network, Puzzle, SettingsIcon } from 'lucide-react'
import { Suspense } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'ui/collapsible'
import { TitlebarProvider } from 'ui/layout/titlebar'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from 'ui/sidebar'

import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'
import { DevBuildBadge } from '@/app/_components/dev-build-badge'
import { RightSidebar } from '@/app/_shell/right-sidebar'
import { SignOutItem } from '@/app/(auth)/_components/sign-out-item'

interface Props {
  pinnedSpaces: SpaceSummary[]
  dashboards: DashboardMeta[]
  pinnedDashboardSlugs: string[]
  children: React.ReactNode
}

interface SidebarProps {
  pinnedSpaces: SpaceSummary[]
  dashboards: DashboardMeta[]
  pinnedDashboardSlugs: string[]
}

function AppSidebar({ pinnedSpaces, dashboards, pinnedDashboardSlugs }: SidebarProps) {
  const pathname = useLocation({ select: (l) => l.pathname })
  const pinnedDashboards = dashboards.filter((d) => pinnedDashboardSlugs.includes(d.slug))

  return (
    <Sidebar collapsible='icon'>
      <SidebarHeader>
        <SidebarTrigger />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <Collapsible defaultOpen className='group/collapsible'>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip='Spaces' isActive={pathname === '/spaces'}>
                  <Link to='/spaces'>
                    <Network />
                    <span>Spaces</span>
                  </Link>
                </SidebarMenuButton>
                {pinnedSpaces.length > 0 && (
                  <>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuAction>
                        <ChevronRight className='transition-transform group-data-[state=open]/collapsible:rotate-90' />
                      </SidebarMenuAction>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {pinnedSpaces.map((space) => (
                          <SidebarMenuSubItem key={space.id}>
                            <SidebarMenuSubButton asChild isActive={pathname === `/space/${space.slug}`}>
                              <Link to='/space/$slug' params={{ slug: space.slug }}>
                                <span>{space.name}</span>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </>
                )}
              </SidebarMenuItem>
            </Collapsible>
          </SidebarMenu>
        </SidebarGroup>
        <DashboardsSidebarSection dashboards={pinnedDashboards} />
        {/*
          A group chat belongs to its members, not to a space, so this section
          is not space-scoped. Routed rather than tab-based: a group chat is a
          place you navigate to, not a session you dock.
        */}
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip='Group chats' isActive={pathname.startsWith('/group-chats')}>
                <Link to='/group-chats'>
                  <MessagesSquare />
                  <span>Group chats</span>
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

export function AppShell({ pinnedSpaces, dashboards, pinnedDashboardSlugs, children }: Props) {
  return (
    <TitlebarProvider>
      <SidebarProvider style={{ '--sidebar-width': '24rem' } as React.CSSProperties}>
        <Suspense fallback={null}>
          <AppSidebar pinnedSpaces={pinnedSpaces} dashboards={dashboards} pinnedDashboardSlugs={pinnedDashboardSlugs} />
        </Suspense>
        <main className='flex flex-col w-full h-dvh'>{children}</main>
        <RightSidebar />
      </SidebarProvider>
    </TitlebarProvider>
  )
}
