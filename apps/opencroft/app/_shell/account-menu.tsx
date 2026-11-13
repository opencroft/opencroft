'use client'

import { THEME_PREFERENCES, type ThemePreference } from '@opencroft/auth/theme'
import { Link, useRouteContext, useRouter } from '@tanstack/react-router'
import { Heart, LogOut, type LucideIcon, Monitor, Moon, Puzzle, SettingsIcon, ShieldCheck, Sun } from 'lucide-react'
import { type ReactElement, useMemo } from 'react'
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
import { type TitleBarOpenFailure, TitleBarPageLinks } from 'ui/layouts/title-bar'

import { useBuildLabel } from '@/app/_components/dev-build-badge'
import { SPONSOR_URL } from '@/app/_shell/sponsor'
import { useThemePreference } from '@/app/_shell/theme-preference'
import { useSignOut } from '@/app/(auth)/_components/sign-out-item'

function initials(name: string) {
  return name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

/** The signed-in person's picture, or their initials while there is none. */
export function AccountAvatar({ className }: { className?: string }) {
  const { account } = useRouteContext({ from: '/_authed' })
  return (
    <Avatar className={className}>
      {/* Kept mounted so the server-rendered page already carries the image. */}
      {account.avatarUrl && <AvatarImage src={account.avatarUrl} alt='' keepMounted />}
      <AvatarFallback className='text-xs'>{initials(account.name || account.email)}</AvatarFallback>
    </Avatar>
  )
}

export interface AccountPage {
  label: string
  to: '/settings' | '/extensions' | '/administration'
  icon: LucideIcon
  /** Offered only to an administrator; `/_authed` turns anyone else away from it. */
  adminOnly?: boolean
}

/**
 * What the account offers, wherever it is shown: the menu behind the title
 * bar's avatar, the phone's Account page and the App Launcher. One list, so
 * they cannot drift. Lists that offer the pages take them from
 * `useAccountPages`, which leaves out what this reader may not open; the
 * whole list is for naming the page the reader is already on.
 */
export const ACCOUNT_PAGES: AccountPage[] = [
  { label: 'Settings', to: '/settings', icon: SettingsIcon },
  { label: 'Extensions', to: '/extensions', icon: Puzzle },
  { label: 'Administration', to: '/administration', icon: ShieldCheck, adminOnly: true },
]

export function accountPagesFor(isAdmin: boolean): AccountPage[] {
  return ACCOUNT_PAGES.filter((page) => !page.adminOnly || isAdmin)
}

/**
 * The account's pages this reader may open, decided by the same `isAdmin`
 * the `/_authed` redirect acts on, so an entry shown is never one that
 * bounces.
 */
export function useAccountPages(): AccountPage[] {
  const { isAdmin } = useRouteContext({ from: '/_authed' })
  return useMemo(() => accountPagesFor(isAdmin), [isAdmin])
}
export const SPONSOR_LINK = { label: 'Sponsor', href: SPONSOR_URL, icon: Heart }
export const SIGN_OUT = { label: 'Sign out', icon: LogOut }

export const THEME_CHOICES: Record<ThemePreference, { label: string; icon: LucideIcon }> = {
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

/**
 * Copy link to this page and Open link from clipboard, with the app's own
 * notices and router: the same items wherever a menu offers them.
 */
export function PageLinks({ shown, separator }: { shown?: 'installed' | 'always'; separator?: boolean }) {
  const router = useRouter()
  return (
    <TitleBarPageLinks
      shown={shown}
      separator={separator}
      onCopied={announceCopy}
      onOpenFailed={announceOpenFailure}
      onNavigate={(path) => router.history.push(path)}
    />
  )
}

interface AccountMenuProps {
  /**
   * The element that opens the menu, with its own content, such as the title
   * bar's avatar button. It is rendered as the menu's trigger, so the
   * trigger's props land on it.
   */
  trigger: ReactElement
}

/** The account's menu: page links, settings, extensions, sponsor, theme, sign out and the build. */
export function AccountMenu({ trigger }: AccountMenuProps) {
  const { account } = useRouteContext({ from: '/_authed' })
  const pages = useAccountPages()
  const signOut = useSignOut()
  const buildLabel = useBuildLabel()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align='end' className='w-56'>
        <PageLinks />
        <DropdownMenuGroup>
          <DropdownMenuLabel className='truncate'>{account.name || account.email}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {pages.map(({ label, to, icon: Icon }) => (
          <DropdownMenuItem key={to} render={<Link to={to} />}>
            <Icon />
            {label}
          </DropdownMenuItem>
        ))}
        {/* biome-ignore lint/a11y/useAnchorContent: the label is the item's children, placed inside the anchor at render */}
        <DropdownMenuItem render={<a href={SPONSOR_LINK.href} target='_blank' rel='noopener noreferrer' />}>
          <SPONSOR_LINK.icon />
          {SPONSOR_LINK.label}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <ThemeChoices />
        {signOut && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <SIGN_OUT.icon />
              {SIGN_OUT.label}
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
