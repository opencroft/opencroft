'use client'

import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'

import { ACCOUNT_PATH, APPS_PATH, CHATS_PATH, isRootPage, SPACES_PATH } from '@/app/_shell/roots'
import { entryIndexOf, goBackThen } from '@/lib/history-go-back'

/**
 * The app moves like an app, not like a browser, at every width: the root
 * pages are the roots of their stacks, a page opened from one is pushed onto
 * its stack, Back pops it, and switching to another root drops the stack
 * rather than piling the new root on top of it.
 *
 * The stack is the run of history entries since the reader last stood on a
 * root, measured by the router's entry index, which it keeps in each entry's
 * state. A page opened straight from a link has no root below it, so its Back
 * goes to the root it belongs under instead of leaving the app.
 */

// Where a page split into a menu and its open section (the kit's MenuLayout)
// shows both side by side, from its md breakpoint up. Below it the section is
// a screen over the menu.
const SPLIT = '(width >= 48rem)'

/**
 * Whether a split page's levels share one screen now. Then opening another
 * section replaces the entry rather than stacking on it, so Back leaves the
 * page instead of stepping through the sections chosen on it.
 */
export function isSplitView(): boolean {
  return window.matchMedia(SPLIT).matches
}

/** The root a page sits under, for a Back with no root below it. */
function rootOf(pathname: string): string {
  if (pathname.startsWith(CHATS_PATH)) {
    return CHATS_PATH
  }
  if (['/settings', '/extensions', '/administration'].some((page) => pathname.startsWith(page))) {
    return ACCOUNT_PATH
  }
  return APPS_PATH
}

const SPACE_SETTINGS = /^(\/space\/[^/]+\/settings)(\/.+)?$/

/**
 * The page a page sits on, for a Back with nothing below it: an app's page in
 * a space's settings sits on their Apps section, the space's settings on the
 * spaces; a section opened in a page's query (a settings section) sits on the
 * page's menu; anything else on its root.
 */
function parentOf(pathname: string): string {
  const spaceSettings = SPACE_SETTINGS.exec(pathname)
  if (spaceSettings) {
    return spaceSettings[2] ? `${spaceSettings[1]}?section=apps` : window.location.search ? pathname : SPACES_PATH
  }
  return window.location.search ? pathname : rootOf(pathname)
}

function entryIndex(): number | null {
  return entryIndexOf(window.history.state)
}

// The entry index of the root the reader last stood on, in this tab. Module
// state, because it describes the window's history, which outlives any one
// mounted component.
let rootIndex: number | null = null

/** Remembers where the current stack starts, whenever a root page is shown. */
export function useTrackScreenStack(pathname: string) {
  useEffect(() => {
    if (isRootPage(pathname)) {
      rootIndex = entryIndex()
    }
  }, [pathname])
}

function depth(): number {
  const index = entryIndex()
  return rootIndex !== null && index !== null && index > rootIndex ? index - rootIndex : 0
}

export function useScreenStack() {
  const router = useRouter()

  /** Goes to another root, in place of the current stack; the one shown already stays. */
  const switchRoot = useCallback(
    (href: string) => {
      if (href !== router.state.location.pathname) {
        goBackThen(depth(), () => router.history.replace(href))
      }
    },
    [router],
  )

  /** Pops the current page. With nothing below it, goes to the page it sits on instead. */
  const back = useCallback(
    (pathname: string) => {
      if (depth() > 0) {
        router.history.back()
      } else {
        router.history.replace(parentOf(pathname))
      }
    },
    [router],
  )

  return { switchRoot, back }
}
