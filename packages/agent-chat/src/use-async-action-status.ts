'use client'

// Generic lifecycle for a host-triggered async action with pollable status:
// seed the real status on mount/key change (a job started elsewhere -- another
// tab, another agent -- is still running from here too), poll while busy and
// stop once settled, and turn a request's refusal into the same render-state
// shape a status poll would produce.
//
// Opaque to the status shape and to what the action even is on purpose --
// compacting a conversation and clearing it are both this same lifecycle
// (seed, poll, render an outcome), and a host-agnostic package has no
// business knowing either one's wire shape. `isBusy`/`describe` are how a
// caller supplies that without this hook importing it.
//
// `fetchStatus`/`requestAction` must be identity-stable (wrap them in
// useCallback at the call site) -- `trigger` below is memoized on
// `requestAction` alone, and an inline arrow from the caller would defeat
// that the same way an unstable prop defeats any other memo.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const POLL_INTERVAL_MS = 2000

export interface AsyncActionOutcome {
  message?: string
  tone: 'default' | 'destructive'
}

export interface AsyncActionRenderState {
  trigger: () => void
  busy: boolean
  message?: string
  tone: 'default' | 'destructive'
}

export function useAsyncActionStatus<TStatus>(
  key: string,
  fetchStatus: (key: string) => Promise<TStatus>,
  requestAction: (key: string) => Promise<{ ok: true } | { ok: false; message: string }>,
  isBusy: (status: TStatus | null) => boolean,
  describe: (status: TStatus | null) => AsyncActionOutcome,
): AsyncActionRenderState {
  const [status, setStatus] = useState<TStatus | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [requesting, setRequesting] = useState(false)
  const keyRef = useRef(key)
  keyRef.current = key
  const fetchStatusRef = useRef(fetchStatus)
  fetchStatusRef.current = fetchStatus

  // Seed on mount/key change rather than assuming idle.
  useEffect(() => {
    let current = true
    setStatus(null)
    setRefusal(null)
    fetchStatusRef
      .current(key)
      .then((s) => {
        if (current) {
          setStatus(s)
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [key])

  const statusBusy = status !== null && isBusy(status)
  useEffect(() => {
    if (!statusBusy) {
      return
    }
    const timer = setInterval(() => {
      fetchStatusRef
        .current(keyRef.current)
        .then(setStatus)
        .catch(() => {})
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [statusBusy])

  const trigger = useCallback(() => {
    setRefusal(null)
    setRequesting(true)
    requestAction(keyRef.current)
      .then((result) => {
        if (!result.ok) {
          setRefusal(result.message)
          return undefined
        }
        return fetchStatusRef.current(keyRef.current).then(setStatus)
      })
      .catch(() => setRefusal('That could not be completed.'))
      .finally(() => setRequesting(false))
  }, [requestAction])

  const busy = requesting || statusBusy
  // Not read as a dependency below -- describe() is called for its two
  // primitive fields, and depending on the object itself would defeat the
  // memo the same bug this whole hook exists to fix, since `describe` has no
  // stability contract (unlike `requestAction`, it's plain data-shaping, not
  // a network call worth memoizing at the caller).
  const outcome = describe(status)
  const message = refusal ?? outcome.message
  const tone = refusal ? 'destructive' : outcome.tone

  // The bug this fixes: without this memo, EVERY render of this hook returns
  // a fresh object literal, even when nothing above actually changed. A
  // caller that puts that object in another memo's deps (ContextRing's render
  // state, in configExtra) sees a "changed" dependency every time, recomputes,
  // and if that recomputed value flows into something republished on every
  // change (the overlay slot `barNode` feeds), the result is state update ->
  // render -> "changed" dependency again -> update -> ... forever. Memoizing
  // on the PRIMITIVE outputs (busy/message/tone are strings/booleans, trigger
  // is its own stable callback) is what breaks that loop: this object's
  // identity now only changes when one of those actually does.
  return useMemo(() => ({ trigger, busy, message, tone }), [trigger, busy, message, tone])
}
