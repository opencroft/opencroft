'use client'

import { useLocation, useRouter } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'

import { readUrlParam, withUrlParam } from '@/app/_lib/url-params'

export interface UrlParamWriteOptions {
  /**
   * Replace the current history entry instead of pushing a new one.
   *
   * Defaults to `true`. A parameter that mirrors on-screen state changes as
   * often as that state does, and pushing every change makes the back button
   * walk back through them one at a time instead of leaving the surface. Pass
   * `false` where the change really is a navigation of its own.
   */
  replace?: boolean
}

export interface UrlParamControls {
  /** The current value, or `null` when the parameter is absent. */
  value: string | null
  /** Write the parameter, leaving every other parameter untouched. */
  set: (value: string, options?: UrlParamWriteOptions) => void
  /** Remove the parameter, leaving every other parameter untouched. */
  remove: (options?: UrlParamWriteOptions) => void
}

/**
 * Read and write one URL search parameter, for state that should survive a
 * reload and be shareable as a link.
 *
 * Re-renders only when this parameter's own value changes: the subscription
 * selects the value, not the query string, so an unrelated parameter moving
 * does not wake every caller. Writes read the current query string from the
 * router at the moment they run, rather than closing over a subscribed copy,
 * which would put that back.
 */
export function useUrlParam(name: string): UrlParamControls {
  const router = useRouter()
  const value = useLocation({ select: (location) => readUrlParam(location.searchStr, name) })

  const apply = useCallback(
    (next: string | null, options?: UrlParamWriteOptions) => {
      const { pathname, searchStr } = router.state.location
      router.navigate({
        to: pathname,
        search: withUrlParam(searchStr, name, next),
        replace: options?.replace ?? true,
      })
    },
    [router, name],
  )

  const set = useCallback(
    (next: string, options?: UrlParamWriteOptions) => {
      apply(next, options)
    },
    [apply],
  )

  const remove = useCallback(
    (options?: UrlParamWriteOptions) => {
      apply(null, options)
    },
    [apply],
  )

  return useMemo(() => ({ value, set, remove }), [value, set, remove])
}
