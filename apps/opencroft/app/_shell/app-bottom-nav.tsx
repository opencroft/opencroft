'use client'

import { type MouseEvent, type PointerEvent, useRef } from 'react'
import { BottomNav, BottomNavItem } from 'ui/navigation/bottom-nav'

import { AccountAvatar } from '@/app/_shell/account-menu'
import { useAppLauncher } from '@/app/_shell/app-launcher-host'
import { ACCOUNT_PATH, ROOTS } from '@/app/_shell/roots'
import { useScreenStack } from '@/app/_shell/screen-stack'
import type { SpaceNavigation } from '@/app/_shell/space-navigation'

/**
 * A swipe is a mostly sideways move at least this long. Well past the ~10px
 * a tap may drift, so a tap that drifts stays a tap.
 */
const SWIPE_MIN_PX = 40

/**
 * The phone's root pages, in thumb reach: the chats, the apps (the App Launcher
 * page), the spaces and the account (its page). It shows on those pages only.
 * Choosing one replaces the current stack instead of adding to the history
 * (see screen-stack). The title bar drops its chats button and account menu
 * below md.
 *
 * The pill is also a strip to switch apps on: a swipe to the right goes back
 * to the app before this one, and further back with each swipe in a run; a
 * swipe to the left retraces the run. It owns every move on it
 * (`touch-action: none`), as nothing on it scrolls.
 */
export function AppBottomNav({ navigation }: { navigation: SpaceNavigation }) {
  const launcher = useAppLauncher()
  const { switchRoot } = useScreenStack()
  const { pathname } = navigation
  const start = useRef<{ x: number; y: number } | null>(null)
  const swiped = useRef(false)

  const onPointerDown = (event: PointerEvent) => {
    start.current = { x: event.clientX, y: event.clientY }
    swiped.current = false
  }
  const onPointerUp = (event: PointerEvent) => {
    const from = start.current
    start.current = null
    if (!from) {
      return
    }
    const dx = event.clientX - from.x
    const dy = event.clientY - from.y
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > 2 * Math.abs(dy)) {
      swiped.current = true
      launcher.step(dx > 0 ? 'back' : 'forward')
    }
  }
  // The press that ended a swipe would otherwise click the item it ended on.
  const onClickCapture = (event: MouseEvent) => {
    if (swiped.current) {
      swiped.current = false
      event.preventDefault()
      event.stopPropagation()
    }
  }
  return (
    <BottomNav
      aria-label='Main'
      className='touch-none'
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        start.current = null
      }}
      onClickCapture={onClickCapture}
    >
      {/* Buttons, not links: they are the app's controls rather than the
          document's links, so they do nothing until the page has hydrated
          instead of loading the root as a new page with history of its own.
          The account is the reader's own picture. */}
      {ROOTS.map(({ path, label, icon: Icon }) => (
        <BottomNavItem
          key={path}
          render={<button type='button' onClick={() => switchRoot(path)} />}
          icon={path === ACCOUNT_PATH ? <AccountAvatar className='size-6' /> : <Icon />}
          label={label}
          active={pathname === path}
        />
      ))}
    </BottomNav>
  )
}
