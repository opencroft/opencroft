'use client'

import { useEffect } from 'react'

/** Calls `onEscape` while the Escape key is pressed anywhere on the page. */
export function useEscapeKey(onEscape: () => void): void {
  useEffect(() => {
    function handle(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onEscape()
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [onEscape])
}
