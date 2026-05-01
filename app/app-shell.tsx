'use client';

import { AppLink } from '@prisma/client';
import { BookOpen, ChevronRight, ExternalLink, Globe, MessageSquare, Network, SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { getAppLinks } from '@/app/(applink)/applinks/actions';
import { type ChatEntry, listAllChats } from '@/app/(openclaw)/openclaw/actions';
import type { SpaceSummary } from '@/app/(space)/server/types';
import { DevBuildBadge } from '@/app/components/dev-build-badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { TitlebarProvider } from '@/components/ui/layout/titlebar';
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
} from '@/components/ui/sidebar';

interface Props {
  pinnedSpaces: SpaceSummary[];
  children: React.ReactNode;
}

function shortChatLabel(chat: ChatEntry): string {
  if (chat.title) {
    return chat.title;
  }
  const parts = chat.key.split(':');
  return parts[parts.length - 1] || chat.key;
}


function AppSidebar({ pinnedSpaces }: { pinnedSpaces: SpaceSummary[] }) {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const activeChatKey = searchParams?.get('chat') ?? null;
  const [appLinks, setAppLinks] = useState<AppLink[]>([]);
  const [chats, setChats] = useState<ChatEntry[]>([]);
  const inSpace = pathname.startsWith('/space/');
  const currentSpaceSlug = inSpace ? pathname.split('/')[2] : '';

  useEffect(() => {
    getAppLinks().then(setAppLinks);
  }, []);

  useEffect(() => {
    if (!inSpace) {
      setChats([]);
      return;
    }
    listAllChats().then(setChats).catch(() => setChats([]));
  }, [inSpace, pathname]);

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
                <SidebarMenuButton
                  asChild
                  tooltip='Spaces'
                  isActive={pathname === '/spaces'}
                >
                  <Link href='/spaces'>
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
                        {pinnedSpaces.map(space => (
                          <SidebarMenuSubItem key={space.id}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={pathname === `/space/${space.slug}`}
                            >
                              <Link href={`/space/${space.slug}`}>
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
        {inSpace && (
          <SidebarGroup>
            <SidebarMenu>
              <Collapsible defaultOpen className='group/collapsible'>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip='Chats'>
                    <MessageSquare />
                    <span>Chats</span>
                  </SidebarMenuButton>
                  {chats.length > 0 && (
                    <>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuAction>
                          <ChevronRight className='transition-transform group-data-[state=open]/collapsible:rotate-90' />
                        </SidebarMenuAction>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {chats.map(chat => (
                            <SidebarMenuSubItem key={chat.key}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={activeChatKey === chat.key}
                              >
                                <Link href={`/space/${currentSpaceSlug}?chat=${encodeURIComponent(chat.key)}`}>
                                  {chat.agentAvatar ? (
                                    <img
                                      src={chat.agentAvatar}
                                      alt=''
                                      className='size-4 shrink-0 rounded-full object-cover'
                                    />
                                  ) : (
                                    <MessageSquare className='size-4 shrink-0' />
                                  )}
                                  <span>{shortChatLabel(chat)}</span>
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
        )}
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip='Documentation'
                isActive={pathname.startsWith('/docs')}
              >
                <Link href='/docs'>
                  <BookOpen />
                  <span>Documentation</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        {appLinks.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Links</SidebarGroupLabel>
            <SidebarMenu>
              {appLinks.map(link => (
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
            <SidebarMenuButton asChild tooltip='Settings' isActive={pathname.startsWith('/settings')}>
              <Link href='/settings'>
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
  );
}

export function AppShell({ pinnedSpaces, children }: Props) {
  return (
    <TitlebarProvider>
      <SidebarProvider>
        <Suspense fallback={null}>
          <AppSidebar pinnedSpaces={pinnedSpaces} />
        </Suspense>
        <main className='flex flex-col w-full h-screen'>
          {children}
        </main>
      </SidebarProvider>
    </TitlebarProvider>
  );
}
