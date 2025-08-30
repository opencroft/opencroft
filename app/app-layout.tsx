'use client';

import { AppLink } from '@prisma/client';
import { BookOpen, ExternalLink, Globe, LayoutDashboard, SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { getAppLinks } from '@/app/(applink)/applinks/actions';
import { TitlebarProvider } from '@/components/ui/layout/titlebar';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';

function AppSidebar() {
  const pathname = usePathname() ?? '';
  const [appLinks, setAppLinks] = useState<AppLink[]>([]);

  useEffect(() => {
    getAppLinks().then(setAppLinks);
  }, []);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarTrigger />
      </SidebarHeader>
      <SidebarContent>
        {appLinks.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Apps</SidebarGroupLabel>
            <SidebarMenu>
              {appLinks.map(link => (
                <SidebarMenuItem key={link.id}>
                  <SidebarMenuButton asChild tooltip={link.title}>
                    <a href={link.url} target="_blank" rel="noopener noreferrer">
                      <Globe />
                      <span>{link.title}</span>
                      <ExternalLink className="ml-auto size-3 opacity-50" />
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip='Dashboard'
                isActive={pathname === '/' || pathname.startsWith('/space/')}
              >
                <Link href='/'>
                  <LayoutDashboard />
                  <span>Dashboard</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
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
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Settings" isActive={pathname.startsWith('/settings')}>
              <Link href="/settings">
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

export function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <TitlebarProvider>
      <SidebarProvider>
        <AppSidebar />
        <main className="flex flex-col w-full h-screen">
          {children}
        </main>
      </SidebarProvider>
    </TitlebarProvider>
  );
}
