'use client'

import type { DashboardMeta } from '@opencroft/dashboards'
import { DashboardsSidebarSection } from '@opencroft/dashboards/client'
import type { AppLink } from '@opencroft/db'
import { Link, useLocation, useSearch } from '@tanstack/react-router'
import {
  BookOpen,
  ChevronRight,
  ExternalLink,
  Globe,
  MessageSquare,
  Network,
  Puzzle,
  SettingsIcon,
  X,
} from 'lucide-react'
import { Suspense, useEffect, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'ui/collapsible'
import { TitlebarProvider } from 'ui/layout/titlebar'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
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
import { getAppLinks } from '@/app/(applink)/_server/actions'
import { type DocNamespace, listDocNamespaces } from '@/app/(docs)/_server/actions'
import { ChatTabsProvider, useChatTabs } from '@/app/(openclaw)/_lib/chat-tabs-context'
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

function AppSidebar({ pinnedSpaces, dashboards, pinnedDashboardSlugs }: SidebarProps) {
  const pathname = useLocation({ select: (l) => l.pathname })
  const search = useSearch({ strict: false }) as { namespace?: string }
  const activeNamespace = search.namespace ?? null
  const [appLinks, setAppLinks] = useState<AppLink[]>([])
  const [repos, setRepos] = useState<DocNamespace[]>([])
  const inSpace = pathname.startsWith('/space/')
  const chatTabs = useChatTabs()
  const pinnedDashboards = dashboards.filter((d) => pinnedDashboardSlugs.includes(d.slug))
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    getAppLinks().then(setAppLinks)
  }, [])

  useEffect(() => {
    listDocNamespaces()
      .then(setRepos)
      .catch(() => setRepos([]))
  }, [pathname])

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
                  <SidebarMenuButton tooltip='Chats'>
                    <MessageSquare />
                    <span>Chats</span>
                  </SidebarMenuButton>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuAction>
                      <ChevronRight className='transition-transform group-data-[state=open]/collapsible:rotate-90' />
                    </SidebarMenuAction>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {mounted &&
                        chatTabs.tabs.map((tab) => (
                          <SidebarMenuSubItem key={tab.key}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={chatTabs.activeSessionKey === tab.key}
                              onClick={(e) => {
                                e.preventDefault()
                                chatTabs.selectSession(tab.key)
                              }}
                            >
                              <button className='flex items-center gap-2 w-full min-w-0'>
                                {tab.agentAvatar ? (
                                  <img
                                    src={tab.agentAvatar}
                                    alt=''
                                    className='size-4 shrink-0 rounded-full object-cover'
                                  />
                                ) : (
                                  <MessageSquare className='size-4 shrink-0' />
                                )}
                                <span className='truncate'>{tab.label}</span>
                                <span
                                  role='button'
                                  tabIndex={0}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    chatTabs.closeTab(tab.key)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.stopPropagation()
                                      chatTabs.closeTab(tab.key)
                                    }
                                  }}
                                  className='ml-auto size-4 inline-flex items-center justify-center rounded-sm hover:bg-muted hover:text-destructive shrink-0'
                                  aria-label='Close tab'
                                >
                                  <X className='size-3' />
                                </span>
                              </button>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarMenu>
            <Collapsible defaultOpen className='group/collapsible'>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip='Documentation'>
                  <BookOpen />
                  <span>Documentation</span>
                </SidebarMenuButton>
                {repos.length > 0 && (
                  <>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuAction>
                        <ChevronRight className='transition-transform group-data-[state=open]/collapsible:rotate-90' />
                      </SidebarMenuAction>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {repos.map((repo) => (
                          <SidebarMenuSubItem key={repo.namespace}>
                            <SidebarMenuSubButton asChild isActive={activeNamespace === repo.namespace}>
                              <Link to='/docs' search={{ namespace: repo.namespace, file: 'README.md' }}>
                                <span className='truncate'>{repo.name}</span>
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
      </SidebarContent>
      <SidebarFooter>
        {appLinks.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Links</SidebarGroupLabel>
            <SidebarMenu>
              {appLinks.map((link) => (
                <SidebarMenuItem key={link.id}>
                  <SidebarMenuButton asChild tooltip={link.title}>
                    <a href={link.url} target='_blank' rel='noopener noreferrer'>
                      <Globe />
                      <span>{link.title}</span>
                      <ExternalLink className='ml-auto size-3 opacity-50' />
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
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
