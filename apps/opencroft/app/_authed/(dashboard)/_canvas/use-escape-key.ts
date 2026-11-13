'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'

/** Calls `onEscape` while the Escape key is pressed anywhere on the page. */
export function useEscapeKey(onEscape: () => void): void {
  const latest = useRef(onEscape)
  useLayoutEffect(() => {
    latest.current = onEscape
  })

  // One listener for the hook's whole life, never one per `onEscape`. The app
  // hydrates on `document`, so React's own listener there runs first for the
  // same keydown, and a handler it calls can re-render the caller (xyflow's
  // Escape on a focused node unselects it). Replacing this listener during that
  // re-render would drop the key: the DOM skips a listener removed during the
  // dispatch and does not call one added to the target it is already at.
  useEffect(() => {
    function handle(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        latest.current()
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [])
}
