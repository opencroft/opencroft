'use client'

import { useSyncExternalStore } from 'react'

/**
 * Whether the window's history has an entry behind and one ahead of the
 * current one, as the Navigation API reports them, updated on every move.
 * Where the API is missing both read true: a control driven by them stays
 * usable rather than being disabled on a guess. The server render, and the
 * page until it hydrates, read both false: a control there has no handler
 * yet, and a full load (a reload, a traversal to another document) would
 * otherwise show it usable until hydration catches up with the window.
 */
export function useHistoryReach(): { canGoBack: boolean; canGoForward: boolean } {
  const canGoBack = useSyncExternalStore(subscribe, () => window.navigation?.canGoBack ?? true, beforeHydration)
  const canGoForward = useSyncExternalStore(subscribe, () => window.navigation?.canGoForward ?? true, beforeHydration)
  return { canGoBack, canGoForward }
}

function beforeHydration() {
  return false
}

function subscribe(onChange: () => void) {
  const navigation = window.navigation
  if (!navigation) {
    return () => {}
  }
  navigation.addEventListener('currententrychange', onChange)
  return () => navigation.removeEventListener('currententrychange', onChange)
}
