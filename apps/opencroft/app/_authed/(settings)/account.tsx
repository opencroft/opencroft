import { THEME_PREFERENCES, type ThemePreference } from '@opencroft/auth/theme'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from 'ui/item'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'
import { ToggleGroup, ToggleGroupItem } from 'ui/toggle-group'

import { useBuildLabel } from '@/app/_components/dev-build-badge'
import { pageTitle } from '@/app/_lib/page-title'
import { AccountAvatar, SIGN_OUT, SPONSOR_LINK, THEME_CHOICES, useAccountPages } from '@/app/_shell/account-menu'
import { useThemePreference } from '@/app/_shell/theme-preference'
import { useSignOut } from '@/app/(auth)/_components/sign-out-item'

// The account menu as a page: where the phone's Account button leads, with
// the same entries as the menu behind the title bar's avatar.
export const Route = createFileRoute('/_authed/(settings)/account')({
  head: () => ({ meta: [{ title: pageTitle('Account') }] }),
  component: AccountPage,
})

function AccountPage() {
  const { account } = Route.useRouteContext()
  const pages = useAccountPages()
  const { theme, choose } = useThemePreference()
  const signOut = useSignOut()
  const buildLabel = useBuildLabel()

  return (
    <ScrollPage>
      <ScrollContent className='gap-4 p-4'>
        <Item variant='muted'>
          <ItemMedia>
            <AccountAvatar className='size-10' />
          </ItemMedia>
          <ItemContent className='min-w-0'>
            <ItemTitle className='truncate'>{account.name || account.email}</ItemTitle>
            {account.name && <ItemDescription className='truncate'>{account.email}</ItemDescription>}
          </ItemContent>
        </Item>

        <ItemGroup className='gap-1'>
          {pages.map(({ label, to, icon: Icon }) => (
            <Item key={to} size='sm' render={<Link to={to} />}>
              <ItemMedia variant='icon'>
                <Icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{label}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <ChevronRight className='size-4 text-muted-foreground' />
              </ItemActions>
            </Item>
          ))}
          {/* biome-ignore lint/a11y/useAnchorContent: the label is the item's children, placed inside the anchor at render */}
          <Item size='sm' render={<a href={SPONSOR_LINK.href} target='_blank' rel='noopener noreferrer' />}>
            <ItemMedia variant='icon'>
              <SPONSOR_LINK.icon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{SPONSOR_LINK.label}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <ExternalLink className='size-4 text-muted-foreground' />
            </ItemActions>
          </Item>
        </ItemGroup>

        <div className='flex flex-col gap-2 px-3'>
          <span className='text-xs font-medium text-muted-foreground'>Theme</span>
          <ToggleGroup
            variant='outline'
            spacing={0}
            value={[theme]}
            onValueChange={(value) => {
              const next = value[0] as ThemePreference | undefined
              if (next) {
                choose(next)
              }
            }}
            className='w-full'
          >
            {THEME_PREFERENCES.map((value) => {
              const { label, icon: Icon } = THEME_CHOICES[value]
              return (
                <ToggleGroupItem key={value} value={value} className='flex-1'>
                  <Icon />
                  {label}
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        </div>

        {signOut && (
          <Item size='sm' render={<button type='button' onClick={signOut} />} className='text-left'>
            <ItemMedia variant='icon'>
              <SIGN_OUT.icon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{SIGN_OUT.label}</ItemTitle>
            </ItemContent>
          </Item>
        )}

        {buildLabel && (
          <p className='truncate px-3 font-mono text-[10px] text-muted-foreground' title={buildLabel}>
            {buildLabel}
          </p>
        )}
      </ScrollContent>
    </ScrollPage>
  )
}
