'use client'

import { useLocation, useRouter } from '@tanstack/react-router'
import {
  type ComponentProps,
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from 'react'

import { appPathOf, resolveAppHref } from '@/app/_authed/(apps)/_lib/app-routes'

/**
 * An App's pages live under its instance's address, as real paths: the host
 * route matches the instance and hands everything after it to the App, which
 * matches it itself. What an App reads and writes here is always App-relative
 * — `/item/K-1`, never the instance's address — so an App cannot tell which
 * space or slug it was added under, and does not need to.
 */

/** The instance's own address, `/space/<space>/app/<app>`. */
const AppBaseContext = createContext<string | null>(null)

function useAppBase(caller: string): string {
  const base = useContext(AppBaseContext)
  if (base === null) {
    throw new Error(`${caller} is only available inside an App's page`)
  }
  return base
}

export function AppRouterProvider({ base, children }: { base: string; children: ReactNode }) {
  return <AppBaseContext.Provider value={base}>{children}</AppBaseContext.Provider>
}

export interface AppLocation {
  /** The App-relative path, e.g. `/item/K-1`. */
  path: string
  search: URLSearchParams
}

/** Where the App is: re-renders the caller on every move within the App. */
export function useAppLocation(): AppLocation {
  const base = useAppBase('useAppLocation')
  const pathname = useLocation({ select: (location) => location.pathname })
  const searchStr = useLocation({ select: (location) => location.searchStr })
  return useMemo(
    () => ({ path: appPathOf(pathname, base), search: new URLSearchParams(searchStr) }),
    [base, pathname, searchStr],
  )
}

/**
 * The address `to` names, for an `href` or a copied link. `to` is an App path
 * (`/item/K-1`, optionally with a query) or a bare query (`?tab=activity`) for
 * the page the App is on.
 */
export function useAppHref(): (to: string) => string {
  const base = useAppBase('useAppHref')
  const pathname = useLocation({ select: (location) => location.pathname })
  return useCallback((to: string) => resolveAppHref(base, appPathOf(pathname, base), to), [base, pathname])
}

export interface AppNavigateOptions {
  /** Rewrite the current history entry instead of adding one. */
  replace?: boolean
}

/**
 * Moves the App to `to` (see useAppHref): a history entry, so back and forward
 * walk the App's pages. The App stays mounted and nothing scrolls.
 */
export function useAppNavigate(): (to: string, options?: AppNavigateOptions) => void {
  const router = useRouter()
  const href = useAppHref()
  return useCallback(
    (to: string, options?: AppNavigateOptions) => {
      router.navigate({ href: href(to), replace: options?.replace, resetScroll: false })
    },
    [router, href],
  )
}

export interface AppLinkProps extends Omit<ComponentProps<'a'>, 'href'> {
  to: string
  replace?: boolean
}

function opensElsewhere(event: MouseEvent<HTMLAnchorElement>): boolean {
  const target = event.currentTarget.getAttribute('target')
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (target !== null && target !== '_self')
  )
}

/**
 * A link to one of the App's pages: a real `<a href>`, so the browser's own
 * gestures (a new tab, a new window, copy link) work on it, while a plain
 * click moves the App in place.
 */
export function AppLink({ to, replace, onClick, ...props }: AppLinkProps) {
  const href = useAppHref()
  const navigate = useAppNavigate()
  return (
    <a
      {...props}
      href={href(to)}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || opensElsewhere(event)) {
          return
        }
        event.preventDefault()
        navigate(to, { replace })
      }}
    />
  )
}
