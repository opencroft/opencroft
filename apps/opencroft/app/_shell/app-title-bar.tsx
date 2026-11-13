'use client'

import { Link, useRouteContext } from '@tanstack/react-router'
import { cn } from 'cn'
import type { LucideIcon } from 'lucide-react'
import { SpaceSelectorIcon } from 'ui/layouts/space-selector'
import { TitleBar, TitleBarIconButton } from 'ui/layouts/title-bar'
import { useSidebar } from 'ui/sidebar'
import { Wordmark } from 'ui/wordmark'

import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'
import { ACCOUNT_PAGES, AccountAvatar, AccountMenu } from '@/app/_shell/account-menu'
import { useAppLauncher } from '@/app/_shell/app-launcher-host'
import { AppTypeMenu } from '@/app/_shell/app-type-menu'
import { PageMenu } from '@/app/_shell/page-menu'
import { ACCOUNT_PATH, APPS_PATH, CHATS_PATH, isRootPage, ROOTS, SPACES_PATH } from '@/app/_shell/roots'
import { useScreenStack } from '@/app/_shell/screen-stack'
import type { SpaceNavigation } from '@/app/_shell/space-navigation'

interface Props {
  spaces: SpaceSummary[]
  navigation: SpaceNavigation
  hasSidebar: boolean
}

const under = (to: string) => (path: string) => path === to || path.startsWith(`${to}/`)

/**
 * The pages outside the spaces, named where an app's name goes: the roots
 * (the chats with their own screens) and the account's pages. The Apps page
 * is the App Launcher itself, so it names nothing.
 */
const PAGES: { label: string; icon: LucideIcon; matches: (pathname: string) => boolean }[] = [
  ...ROOTS.filter((root) => root.path !== APPS_PATH).map(({ path, label, icon }) => ({
    label,
    icon,
    matches: path === CHATS_PATH ? under(path) : (pathname: string) => pathname === path,
  })),
  ...ACCOUNT_PAGES.map(({ label, to, icon }) => ({ label, icon, matches: under(to) })),
]

function pageOf(pathname: string) {
  return PAGES.find((page) => page.matches(pathname))
}

const HERE =
  'flex h-8 min-w-0 items-center gap-2 rounded-md px-1.5 text-sm font-medium hover:bg-accent active:bg-accent pointer-coarse:h-10'

/**
 * The app's title bar: the screen stack's Back below a root, the sidebar
 * button when the page has a sidebar, the mark linking home, where the
 * reader is (the space's icon and the open app's name, opening a menu of the
 * apps of its type in the space; elsewhere opening the App Launcher),
 * the App Launcher, chats, the spaces and the account menu. Below md, the App Launcher,
 * chats, the spaces and the account move to the bottom navigation, and the
 * page's own menu takes the end.
 */
export function AppTitleBar({ spaces, navigation, hasSidebar }: Props) {
  const { account } = useRouteContext({ from: '/_authed' })
  const { toggleSidebar } = useSidebar()
  const launcher = useAppLauncher()
  const { slug, apps, activeAppId } = navigation
  const current = spaces.find((space) => space.slug === slug)
  const activeApp = apps.find((app) => app.id === activeAppId)
  // Where the reader is: in a space, its icon and the open app's name; off
  // one, the page's own icon and name.
  const page = slug ? null : pageOf(navigation.pathname)
  const topLevel = isRootPage(navigation.pathname)
  const stack = useScreenStack()
  // The chats' own screens lead with their Back, one level at a time.
  const hasOwnBack = navigation.pathname.startsWith(`${CHATS_PATH}/`)
  const here = slug ? (
    <>
      <SpaceSelectorIcon icon={current?.icon} className='size-5' />
      <span className='truncate'>{activeApp?.label ?? current?.name ?? slug}</span>
    </>
  ) : (
    page && (
      <>
        <page.icon className='size-5 shrink-0' />
        <span className='truncate'>{page.label}</span>
      </>
    )
  )

  return (
    <TitleBar
      onMenu={hasSidebar ? toggleSidebar : undefined}
      // On a phone the sidebar opens from the page menu instead.
      menuClassName='max-md:hidden'
      // The app moves through screen stacks at every width: a page below a
      // root pops back down its stack, in place of the browser's Back and
      // Forward.
      onBack={topLevel || hasOwnBack ? undefined : () => stack.back(navigation.pathname)}
      brand={
        // Home is a root like the others, so a press goes there in place of
        // the stack rather than on top of it. It is the spaces list, where
        // `/` redirects; a press for a new tab keeps the link.
        <Link
          to='/'
          aria-label='Home'
          onClick={(event) => {
            if (event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
              event.preventDefault()
              stack.switchRoot(SPACES_PATH)
            }
          }}
        >
          <Wordmark />
        </Link>
      }
      // On a phone the full mark shows only on the top-level pages, the ones
      // with the bottom navigation; an app has the bar's whole width.
      brandCompact={topLevel ? undefined : false}
      context={
        here &&
        (slug && activeApp ? (
          // In an app, a menu of the apps of its type in the space.
          <AppTypeMenu apps={apps} activeApp={activeApp} spaceSlug={slug} className={HERE}>
            {here}
          </AppTypeMenu>
        ) : (
          <>
            {/* Where the reader is, as one press to the App Launcher: its page on a
                phone, its dialog from md up. */}
            {/* On a phone a top-level page is named by the bottom navigation already. */}
            {!topLevel && (
              <Link to={APPS_PATH} className={cn(HERE, 'md:hidden')}>
                {here}
              </Link>
            )}
            <button type='button' onClick={launcher.open} className={cn(HERE, 'max-md:hidden')}>
              {here}
            </button>
          </>
        ))
      }
      trailing={
        <>
          {/* Roots, so a switch to one replaces the stack, as the bottom
              navigation's do on a phone; Apps opens the App Launcher's
              dialog, and the account has its menu. */}
          {ROOTS.filter((root) => root.path !== ACCOUNT_PATH).map(({ path, label, icon: Icon }) => (
            <TitleBarIconButton
              key={path}
              aria-label={label}
              title={label}
              onClick={path === APPS_PATH ? launcher.open : () => stack.switchRoot(path)}
              className='max-md:hidden'
            >
              <Icon />
            </TitleBarIconButton>
          ))}
          <AccountMenu
            trigger={
              <TitleBarIconButton aria-label='Account' title={account.email} className='max-md:hidden'>
                <AccountAvatar className='size-6' />
              </TitleBarIconButton>
            }
          />
          <PageMenu className='md:hidden' onSidebar={hasSidebar ? toggleSidebar : undefined} />
        </>
      }
    />
  )
}
