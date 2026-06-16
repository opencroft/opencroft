'use client'

import { Link, useLocation } from '@tanstack/react-router'
import { ChevronRight, LayoutDashboard } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'ui/collapsible'
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from 'ui/sidebar'

import type { DashboardMeta } from '../types'

export function DashboardsSidebarSection({ dashboards }: { dashboards: DashboardMeta[] }) {
  const pathname = useLocation({ select: (l) => l.pathname })
  return (
    <SidebarGroup>
      <SidebarMenu>
        <Collapsible defaultOpen className='group/collapsible'>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip='Dashboards' isActive={pathname === '/dashboards'}>
              <Link to='/dashboards'>
                <LayoutDashboard />
                <span>Dashboards</span>
              </Link>
            </SidebarMenuButton>
            {dashboards.length > 0 && (
              <>
                <CollapsibleTrigger asChild>
                  <SidebarMenuAction>
                    <ChevronRight className='transition-transform group-data-[state=open]/collapsible:rotate-90' />
                  </SidebarMenuAction>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {dashboards.map((dashboard) => (
                      <SidebarMenuSubItem key={dashboard.slug}>
                        <SidebarMenuSubButton asChild isActive={pathname === `/dashboard/${dashboard.slug}`}>
                          <Link to={`/dashboard/${dashboard.slug}`}>
                            <span>{dashboard.title}</span>
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
  )
}
