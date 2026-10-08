'use client'

import { THEME_PREFERENCES, type ThemePreference } from '@opencroft/auth/theme'
import { Link, useLocation, useRouteContext, useRouter } from '@tanstack/react-router'
import { Heart, LogOut, type LucideIcon, MessagesSquare, Monitor, Moon, Puzzle, SettingsIcon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from 'ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'ui/dropdown-menu'
import { AppSwitcher, type SwitcherApp } from 'ui/layouts/app-switcher'
import { SpaceSelector } from 'ui/layouts/space-selector'
import { TitleBar, TitleBarIconButton, type TitleBarOpenFailure, TitleBarPageLinks } from 'ui/layouts/title-bar'
import { Logo } from 'ui/logo'
import { useSidebar } from 'ui/sidebar'
import { Wordmark } from 'ui/wordmark'

import { appBasePath } from '@/app/_authed/(apps)/_lib/app-routes'
import { listApps, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'
import { DEFAULT_GRAPH_SLUG, GRAPH_APP_TYPE, type SpaceSummary } from '@/app/_authed/(space)/_server/types'
import { useBuildLabel } from '@/app/_components/dev-build-badge'
import { useHistoryReach } from '@/app/_shell/history-reach'
import { SPONSOR_URL } from '@/app/_shell/sponsor'
import { useThemePreference } from '@/app/_shell/theme-preference'
import { useSignOut } from '@/app/(auth)/_components/sign-out-item'

/**
 * The space the reader is in: the one in the address, and only that. Off a
 * space's own pages there is none — the title bar shows no current space
 * rather than one somebody else last opened.
 */
function slugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/space\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

function isDefaultGraph(instance: SpaceAppInstance) {
  return instance.type === GRAPH_APP_TYPE && instance.slug === DEFAULT_GRAPH_SLUG
}

/**
 * The space's App instances, as the title bar lists them. The space's graphs
 * are instances too, so they arrive here with the rest; the default one is
 * addressed by the space itself, which is where the space's own link goes.
 * Refetched on every navigation, not only when the space changes, so an
 * instance added in the settings shows up as soon as the reader goes anywhere.
 * Moving between one App's own pages is not going anywhere: the App is the
 * page, so those moves share one trigger and fetch nothing.
 */
function useSpaceApps(slug: string | null, pathname: string): SwitcherApp[] {
  const [instances, setInstances] = useState<SpaceAppInstance[]>([])
  const [apps, setApps] = useState<AppMeta[]>([])
  const page = appBasePath(pathname) ?? pathname

  // biome-ignore lint/correctness/useExhaustiveDependencies: page is the refetch trigger, see above
  useEffect(() => {
    if (!slug) {
      return
    }
    let cancelled = false
    Promise.all([listSpaceApps({ data: slug }), listApps()])
      .then(([nextInstances, nextApps]) => {
        if (!cancelled) {
          setInstances(nextInstances)
          setApps(nextApps)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInstances([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [slug, page])

  if (!slug) {
    return []
  }
  return instances.map((instance) => {
    const meta = apps.find((app) => app.type === instance.type)
    return {
      id: instance.id,
      label: instance.name || meta?.title || instance.type,
      href: isDefaultGraph(instance) ? `/space/${slug}` : `/space/${slug}/app/${instance.slug}`,
      icon: resolveIcon(meta?.icon),
      type: meta?.title ?? instance.type,
    }
  })
}

function initials(name: string) {
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

const THEME_CHOICES: Record<ThemePreference, { label: string; icon: LucideIcon }> = {
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
  system: { label: 'System', icon: Monitor },
}

function ThemeChoices() {
  const { theme, choose } = useThemePreference()
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={choose}>
        {THEME_PREFERENCES.map((value) => {
          const { label, icon: Icon } = THEME_CHOICES[value]
          return (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon />
              {label}
            </DropdownMenuRadioItem>
          )
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  )
}

function announceCopy(copied: boolean) {
  if (copied) {
    toast('Link copied')
  } else {
    toast.error('The link could not be copied.')
  }
}

const OPEN_FAILURE_NOTICES: Record<TitleBarOpenFailure, string> = {
  unreadable: 'The clipboard could not be read.',
  'not-a-link': 'The clipboard does not hold a link.',
  blocked: 'The browser blocked the new window.',
}

function announceOpenFailure(reason: TitleBarOpenFailure) {
  toast.error(OPEN_FAILURE_NOTICES[reason])
}

function AccountMenu() {
  const { account } = useRouteContext({ from: '/_authed' })
  const signOut = useSignOut()
  const buildLabel = useBuildLabel()
  const router = useRouter()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<TitleBarIconButton aria-label='Account' title={account.email} />}>
        <Avatar className='size-6'>
          {/* Kept mounted so the server-rendered page already carries the image. */}
          {account.avatarUrl && <AvatarImage src={account.avatarUrl} alt='' keepMounted />}
          <AvatarFallback className='text-xs'>{initials(account.name || account.email)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-56'>
        <TitleBarPageLinks
          onCopied={announceCopy}
          onOpenFailed={announceOpenFailure}
          onNavigate={(path) => router.history.push(path)}
        />
        <DropdownMenuGroup>
          <DropdownMenuLabel className='truncate'>{account.name || account.email}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to='/settings' />}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link to='/extensions' />}>
          <Puzzle />
          Extensions
        </DropdownMenuItem>
        {/* biome-ignore lint/a11y/useAnchorContent: the label is the item's children, placed inside the anchor at render */}
        <DropdownMenuItem render={<a href={SPONSOR_URL} target='_blank' rel='noopener noreferrer' />}>
          <Heart />
          Sponsor
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <ThemeChoices />
        {signOut && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </>
        )}
        {buildLabel && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className='truncate font-mono text-[10px] font-normal' title={buildLabel}>
              {buildLabel}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The app's title bar: Back and Forward when running as an installed app, the
 * sidebar button when the page has a sidebar, the mark linking home, where the reader is (space, then app), chats and the
 * account menu.
 */
export function AppTitleBar({ spaces, hasSidebar }: { spaces: SpaceSummary[]; hasSidebar: boolean }) {
  const pathname = useLocation({ select: (l) => l.pathname })
  const router = useRouter()
  const { toggleSidebar } = useSidebar()
  const { canGoBack, canGoForward } = useHistoryReach()
  const slug = slugFromPath(pathname)
  const apps = useSpaceApps(slug, pathname)

  const navigate = (href: string) => router.history.push(href)
  // The default graph answers at the space's own address and at its app
  // address alike; every other app only at its own.
  const defaultGraphAppHref = `/space/${slug}/app/${DEFAULT_GRAPH_SLUG}`
  const activeApp = apps.find((app) =>
    app.href === `/space/${slug}`
      ? pathname === app.href || pathname === defaultGraphAppHref || pathname.startsWith(`${defaultGraphAppHref}/`)
      : pathname === app.href || pathname.startsWith(`${app.href}/`),
  )?.id

  return (
    <TitleBar
      onHistoryBack={() => router.history.back()}
      onHistoryForward={() => router.history.forward()}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onMenu={hasSidebar ? toggleSidebar : undefined}
      brand={
        <Link to='/' aria-label='Home'>
          <Wordmark />
        </Link>
      }
      brandCompact={
        <Link to='/' aria-label='Home'>
          <Logo size={24} />
        </Link>
      }
      context={
        slug && (
          <>
            <SpaceSelector
              spaces={spaces}
              currentSlug={slug}
              hrefFor={(space) => `/space/${space}`}
              settingsHrefFor={(space) => `/space/${space}/settings`}
              allSpacesHref='/spaces'
              createHref='/spaces?new=1'
              onNavigate={navigate}
            />
            <AppSwitcher
              apps={apps}
              activeId={activeApp}
              createHref={`/space/${slug}/settings?section=apps&tab=add`}
              onNavigate={navigate}
            />
          </>
        )
      }
      trailing={
        <>
          <TitleBarIconButton render={<Link to='/group-chats' />} nativeButton={false} aria-label='Chats' title='Chats'>
            <MessagesSquare />
          </TitleBarIconButton>
          <AccountMenu />
        </>
      }
    />
  )
}
