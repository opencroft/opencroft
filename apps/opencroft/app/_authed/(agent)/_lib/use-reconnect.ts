'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const MAX_DELAY_MS = 30_000

/**
 * How long to wait before the next attempt, after `failures` in a row.
 *
 * The first one is immediate: it answers a session that went away (an unload,
 * a restart), which is expected and is over as soon as the session is opened
 * again. Only a run of them backs off -- doubling from a second, capped at
 * thirty -- because a run means the server is down or refusing, and a tab that
 * asked again every moment would only add to that.
 */
export function reconnectDelay(failures: number): number {
  if (failures <= 0) {
    return 0
  }
  return Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - 1))
}

/**
 * When a chat tab re-establishes its connection.
 *
 * `schedule` asks for one more attempt; `attempt` is the counter a host puts in
 * the dependencies of whatever opens the connection, so the attempt is simply
 * that effect running again. `connected` says an attempt got through, which
 * starts the backoff over.
 *
 * A hidden tab does not reconnect until it is shown. A reconnect reopens the
 * session, which starts its agent's process if it was stopped, and a reader
 * with many tabs open would otherwise have every one of them bring its agent
 * back the moment the idle unload had put it away. Nothing is lost by waiting:
 * the open replays the session's history, so a tab shown later catches up on
 * everything it missed.
 */
export function useReconnect(): { attempt: number; schedule: () => void; connected: () => void } {
  const [attempt, setAttempt] = useState(0)
  const failures = useRef(0)
  const cancelPending = useRef<(() => void) | null>(null)

  const schedule = useCallback(() => {
    // One attempt pending at a time: a stream that errors and then reports its
    // session gone is one lost connection, not two.
    if (cancelPending.current) {
      return
    }
    const delay = reconnectDelay(failures.current)
    failures.current += 1
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      cancelPending.current = null
    }
    const fire = () => {
      cancel()
      setAttempt((n) => n + 1)
    }
    function onVisible() {
      if (document.visibilityState === 'visible') {
        fire()
      }
    }
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible') {
        fire()
      } else {
        document.addEventListener('visibilitychange', onVisible)
      }
    }, delay)
    cancelPending.current = cancel
  }, [])

  const connected = useCallback(() => {
    failures.current = 0
  }, [])

  useEffect(() => () => cancelPending.current?.(), [])

  return { attempt, schedule, connected }
}
