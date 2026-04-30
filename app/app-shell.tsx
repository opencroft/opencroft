'use client';

import { AppLink } from '@prisma/client';
import { BookOpen, ChevronRight, ExternalLink, Globe, Network, SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { getAppLinks } from '@/app/(applink)/applinks/actions';
import type { SpaceSummary } from '@/app/(space)/server/types';
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

function AppSidebar({ pinnedSpaces }: { pinnedSpaces: SpaceSummary[] }) {
  const pathname = usePathname() ?? '';
  const [appLinks, setAppLinks] = useState<AppLink[]>([]);

  useEffect(() => {
    getAppLinks().then(setAppLinks);
  }, []);

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
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function AppShell({ pinnedSpaces, children }: Props) {
  return (
    <TitlebarProvider>
      <SidebarProvider>
        <AppSidebar pinnedSpaces={pinnedSpaces} />
        <main className='flex flex-col w-full h-screen'>
          {children}
        </main>
      </SidebarProvider>
    </TitlebarProvider>
  );
}
