'use client'

// Discarding a session and starting fresh is a base ACP-session capability,
// same as compact -- just one with no pollable status: the host either
// manages to tear the session down or it doesn't, and the ContextRing's own
// confirm step (a second press while it's still asking) is what stands
// between a stray click and losing a transcript, not anything this hook
// tracks. All this guards is the request itself: no second clear firing
// while one is already in flight.
import { useCallback, useMemo, useState } from 'react'

export interface ClearRenderState {
  onClear?: () => void
  clearing: boolean
}

export function useClearControl(clearSession?: () => void | Promise<void>): ClearRenderState {
  const [clearing, setClearing] = useState(false)

  const trigger = useCallback(() => {
    if (!clearSession || clearing) {
      return
    }
    setClearing(true)
    // Catches its own failure rather than leaving a rejection unhandled -- a
    // refusal (a host that rejects a clear it cannot honour) is still an
    // outcome the in-flight guard below needs to release from, and a
    // destructive control that fails silently is worse than one that logs.
    Promise.resolve(clearSession())
      .catch((err) => {
        console.error('Failed to clear session', err)
      })
      .finally(() => setClearing(false))
  }, [clearSession, clearing])

  // Same identity-stability contract as useAsyncActionStatus, even though
  // nothing downstream currently puts the whole object in a dependency array
  // (only `.onClear` is destructured) -- a caller that later does would hit
  // the exact render-loop class that hook's memo exists to prevent, so this
  // stays memoized rather than relying on today's one call site never doing
  // that.
  const onClear = clearSession ? trigger : undefined
  return useMemo(() => ({ onClear, clearing }), [onClear, clearing])
}
