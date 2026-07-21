'use client'

import type { DashboardMeta } from '@opencroft/dashboards'
import { DashboardsSidebarSection } from '@opencroft/dashboards/client'
import { Link, useLocation } from '@tanstack/react-router'
import { ChevronRight, MessageSquare, Network, PanelRightOpen, Puzzle, SettingsIcon } from 'lucide-react'
import { Suspense, useEffect, useState } from 'react'
import { Button } from 'ui/button'
import { ChatListItem } from 'ui/chat/chat-list-item'
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

import { DevBuildBadge } from '@/app/_components/dev-build-badge'
import { ChatTabsProvider, useChatTabs } from '@/app/(agent)/_lib/chat-tabs-context'
import { listPendingPermissions } from '@/app/(agent)/_server/acp'
import type { SpaceSummary } from '@/app/(space)/_server/types'

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

// Poll for chat sessions blocked on a permission request, so their sidebar
// avatars can show a pending dot. Gated off when no chats are open.
function usePendingPermissionKeys(enabled: boolean): Set<string> {
  const [keys, setKeys] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!enabled) {
      setKeys(new Set())
      return
    }
    let cancelled = false
    const poll = () => {
      listPendingPermissions().then((list) => {
        if (!cancelled) {
          setKeys(new Set(list))
        }
      })
    }
    poll()
    const id = window.setInterval(poll, 2500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [enabled])
  return keys
}

function ChatModeToggle() {
  const chatTabs = useChatTabs()
  const focused = chatTabs.chatMode === 'focused'
  return (
    <Button
      variant='ghost'
      size='icon'
      className='size-7 group-data-[collapsible=icon]:hidden'
      onClick={chatTabs.toggleChatMode}
      title={focused ? 'Chat mode: focused (overlay)' : 'Chat mode: docked'}
    >
      <PanelRightOpen className={focused ? 'text-primary' : 'text-muted-foreground'} />
    </Button>
  )
}

function AppSidebar({ pinnedSpaces, dashboards, pinnedDashboardSlugs }: SidebarProps) {
  const pathname = useLocation({ select: (l) => l.pathname })
  const inSpace = pathname.startsWith('/space/')
  const chatTabs = useChatTabs()
  const pinnedDashboards = dashboards.filter((d) => pinnedDashboardSlugs.includes(d.slug))
  const [mounted, setMounted] = useState(false)
  const pendingKeys = usePendingPermissionKeys(inSpace && mounted && chatTabs.tabs.length > 0)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <Sidebar collapsible='icon'>
      <SidebarHeader>
        <div className='flex items-center justify-between'>
          <SidebarTrigger />
          <ChatModeToggle />
        </div>
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
                              <Link to={`/space/${space.slug}`}>
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
        {inSpace && (
          <SidebarGroup>
            <SidebarMenu>
              <Collapsible defaultOpen className='group/collapsible'>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip='Chats' onClick={chatTabs.openChatList}>
                    <MessageSquare />
                    <span>Chats</span>
                  </SidebarMenuButton>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuAction>
                      <ChevronRight className='transition-transform group-data-[state=open]/collapsible:rotate-90' />
                    </SidebarMenuAction>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className='flex flex-col gap-0.5 px-1.5 py-0.5'>
                      {mounted &&
                        chatTabs.tabs.map((tab) => (
                          <ChatListItem
                            key={tab.key}
                            id={tab.key}
                            title={tab.title ?? tab.label}
                            description={tab.agentName}
                            avatarUrl={tab.agentAvatar}
                            active={chatTabs.activeSessionKey === tab.key}
                            pending={pendingKeys.has(tab.key)}
                            onSelect={chatTabs.selectSession}
                            onClose={chatTabs.closeTab}
                          />
                        ))}
                    </div>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroup>
        )}
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
        <DevBuildBadge />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

export function AppShell({ pinnedSpaces, dashboards, pinnedDashboardSlugs, children }: Props) {
  return (
    <TitlebarProvider>
      <ChatTabsProvider>
        <SidebarProvider style={{ '--sidebar-width': '24rem' } as React.CSSProperties}>
          <Suspense fallback={null}>
            <AppSidebar
              pinnedSpaces={pinnedSpaces}
              dashboards={dashboards}
              pinnedDashboardSlugs={pinnedDashboardSlugs}
            />
          </Suspense>
          <main className='flex flex-col w-full h-dvh'>{children}</main>
        </SidebarProvider>
      </ChatTabsProvider>
    </TitlebarProvider>
  )
}
