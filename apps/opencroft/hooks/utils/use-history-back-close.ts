'use client'

import { useCallback, useEffect, useRef } from 'react'

import { goBackThen } from '@/lib/history-go-back'

// A marker on the synthetic entry, so cleanup can tell "still sitting on the
// entry this hook pushed" from "the browser already left it". Namespaced to
// survive sharing history.state with the router, which keeps its own keys
// there -- the entry is pushed with the router's state spread in, so going
// back to it looks to the router like the page it already shows.
const STATE_FLAG = '__opencroftBackClose'

function onSyntheticEntry() {
  const state = window.history.state as Record<string, unknown> | null
  return Boolean(state?.[STATE_FLAG])
}

/**
 * Makes the browser's Back action close a full-screen cover instead of
 * leaving the page.
 *
 * While `active`, one synthetic history entry sits on top of the stack: Back
 * consumes it and `onClose` fires, so the page underneath is still the page
 * the reader was on. Closing the cover any other way consumes the entry
 * silently, so Back afterwards leaves the page as it always did. The entry is
 * same-URL, which routers treat as a no-op.
 *
 * Returns `leaveThen` for a cover that navigates as it closes: it consumes
 * the entry first and runs the navigation once the browser is back on the
 * page beneath, so the new page lands where the cover's entry was instead of
 * on top of it. Navigating straight away races the entry's removal: the router
 * queues its history writes, so a push can land before or after the Back that
 * removes the entry.
 */
export function useHistoryBackClose(active: boolean, onClose: () => void) {
  // The latest close handler without re-arming the effect: callers pass a
  // fresh closure every render, and re-pushing an entry per render would bury
  // the real history under synthetic ones.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // Set while `leaveThen` takes the entry away itself, so neither the Back it
  // triggers nor the cleanup that follows treats the entry as still to close.
  const leaving = useRef(false)

  useEffect(() => {
    if (!active) {
      return
    }
    leaving.current = false
    window.history.pushState({ ...window.history.state, [STATE_FLAG]: true }, '')
    const onPop = () => {
      if (!leaving.current) {
        closeRef.current()
      }
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Closed by its own controls rather than by Back: the synthetic entry is
      // still on top, and leaving it there would make the NEXT Back a no-op.
      // Navigating away instead lands here with a different entry on top, and
      // that stray must not be consumed.
      if (!leaving.current && onSyntheticEntry()) {
        window.history.back()
      }
    }
  }, [active])

  return useCallback((then: () => void) => {
    if (!onSyntheticEntry()) {
      then()
      return
    }
    leaving.current = true
    goBackThen(1, then)
  }, [])
}
