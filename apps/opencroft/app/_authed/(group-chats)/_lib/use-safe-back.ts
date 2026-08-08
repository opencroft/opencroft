import { useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'

/**
 * Leaves a screen the way the browser's own Back button would: pops the
 * current history entry when this tab actually navigated here in-app, so a
 * subsequent Back lands wherever the user was before this screen rather than
 * back into it. `router.history.canGoBack()` is keyed on the entry's own
 * history-state index being nonzero, which is false exactly when there is no
 * in-app entry underneath it (a direct/deep link) — the only case where a
 * push to `fallbackTo` is correct instead of a pop.
 */
export function useSafeBack(fallbackTo: () => void): () => void {
  const router = useRouter()
  return useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back()
      return
    }
    fallbackTo()
  }, [router, fallbackTo])
}
