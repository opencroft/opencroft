'use client'

import type { DashboardMeta } from '@opencroft/dashboards'
import { DashboardsSidebarSection } from '@opencroft/dashboards/client'
import { Link, useLocation } from '@tanstack/react-router'
import { ChevronRight, MessageSquare, Network, PanelRightOpen, Puzzle, SettingsIcon } from 'lucide-react'
import { Suspense, useEffect, useState } from 'react'
import { Button } from 'ui/button'
import { ChatList } from 'ui/chat/chat-list'
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
import { RenameDialog } from '@/app/(agent)/_components/chat-hosts'
import { ChatTabsProvider, useChatTabs } from '@/app/(agent)/_lib/chat-tabs-context'
import { useAgentSessions } from '@/app/(agent)/_lib/use-agent-sessions'
import { useChatListNodes } from '@/app/(agent)/_lib/use-chat-list-nodes'
import { listPendingPermissions } from '@/app/(agent)/_server/acp'
import type { SpaceSummary } from '@/app/(space)/_server/types'
import { cn } from '@/lib/utils'

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
// avatars can show a pending dot. Gated off when there are no sessions at all.
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
  const { sessions, renameSession, deleteSession } = useAgentSessions()
  const pinnedDashboards = dashboards.filter((d) => pinnedDashboardSlugs.includes(d.slug))
  const [mounted, setMounted] = useState(false)
  const pendingKeys = usePendingPermissionKeys(inSpace && mounted && sessions.length > 0)
  const { nodes, nodesKey, onChange, closeSession } = useChatListNodes(sessions, pendingKeys, chatTabs.activeSessionKey)
  const [renaming, setRenaming] = useState<{ key: string; title: string } | null>(null)

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
                    {mounted && (
                      <ChatList
                        key={nodesKey}
                        nodes={nodes}
                        activeId={chatTabs.activeSessionKey}
                        onSelect={(key) => {
                          // A session opened from history (never an open tab)
                          // has no tab meta yet — resolve it from the registry
                          // so the tab doesn't render as its raw key suffix.
                          const session = sessions.find((s) => s.key === key)
                          chatTabs.selectSession(key, {
                            label: session ? `${session.agentName}: ${session.title ?? session.jobName}` : undefined,
                            agentName: session?.agentName,
                            title: session?.title,
                          })
                        }}
                        onClose={(key) => {
                          // Close = drop the row from the sidebar list without
                          // deleting the session — the
                          // list is sourced from the full session registry, not
                          // open tabs, so closeTab alone is invisible unless the
                          // session also happens to be the active tab.
                          closeSession(key)
                          chatTabs.closeTab(key)
                        }}
                        onDelete={deleteSession}
                        onRename={(key) => {
                          const session = sessions.find((s) => s.key === key)
                          setRenaming({ key, title: session?.title ?? session?.jobName ?? '' })
                        }}
                        onChange={onChange}
                        // Structural classes must stay in sync with `SidebarMenuSub` (packages/ui sidebar.tsx).
                        className={cn(
                          'mx-3.5 min-w-0 translate-x-px border-l border-sidebar-border px-1.5 py-0.5',
                          'group-data-[collapsible=icon]:hidden',
                        )}
                      />
                    )}
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
      {renaming && (
        <RenameDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRenaming(null)
            }
          }}
          title={renaming.title}
          onSubmit={(title) => renameSession(renaming.key, title)}
        />
      )}
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
