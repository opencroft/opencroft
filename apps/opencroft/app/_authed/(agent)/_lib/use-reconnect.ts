'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const MAX_DELAY_MS = 30_000

/**
 * How many failures in a row a tab answers by itself before it stops and asks
 * the reader. With the delays below the run spans 75 to 151 seconds. Without a
 * limit, a tab left open on something that does not clear by itself would ask
 * every thirty seconds for as long as it stays open.
 */
export const MAX_FAILURES = 10

/**
 * How long to wait before the next attempt, after `failures` in a row.
 *
 * The first one is immediate: it answers a session that went away (an unload,
 * a restart), which is expected and is over as soon as the session is opened
 * again. Only a run of them backs off -- doubling from a second, capped at
 * thirty -- because a run means the server is down or refusing, and a tab that
 * asked again every moment would only add to that.
 *
 * Each wait lands anywhere in the upper half of its step. A restart drops every
 * open tab at the same moment, and without the spread they would all come back
 * in step, on every step.
 */
export function reconnectDelay(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) {
    return 0
  }
  const step = Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - 1))
  return step / 2 + (random() * step) / 2
}

export interface Reconnect {
  /** Bumped once per attempt; put it in the dependencies of what connects. */
  attempt: number
  /** True once a run reached MAX_FAILURES: nothing more is scheduled until `retry`. */
  exhausted: boolean
  /** Ask for one more attempt, after the backoff. */
  schedule: () => void
  /** An attempt got through: the next failure starts a fresh run. */
  connected: () => void
  /** The reader asked: attempt now, and start a fresh run. */
  retry: () => void
}

/**
 * When a chat tab re-establishes its connection.
 *
 * `schedule` asks for one more attempt; `attempt` is the counter a host puts in
 * the dependencies of whatever opens the connection, so the attempt is simply
 * that effect running again. `connected` says an attempt got through, which
 * starts the backoff over. A run that reaches MAX_FAILURES stops and says so in
 * `exhausted`; `retry` is the way out of that, and it is the reader's.
 *
 * A hidden tab does not reconnect until it is shown. A reconnect reopens the
 * session, which starts its agent's process if it was stopped, and a reader
 * with many tabs open would otherwise have every one of them bring its agent
 * back the moment the idle unload had put it away. Nothing is lost by waiting:
 * the open replays the session's history, so a tab shown later catches up on
 * everything it missed.
 */
export function useReconnect(): Reconnect {
  const [attempt, setAttempt] = useState(0)
  const [exhausted, setExhausted] = useState(false)
  const failures = useRef(0)
  const cancelPending = useRef<(() => void) | null>(null)

  const schedule = useCallback(() => {
    // One attempt pending at a time: a stream that errors and then reports its
    // session gone is one lost connection, not two.
    if (cancelPending.current) {
      return
    }
    if (failures.current >= MAX_FAILURES) {
      setExhausted(true)
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
    setExhausted(false)
  }, [])

  // Not held back by visibility or backoff: the reader pressed it, in this tab.
  const retry = useCallback(() => {
    cancelPending.current?.()
    failures.current = 0
    setExhausted(false)
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => () => cancelPending.current?.(), [])

  return { attempt, exhausted, schedule, connected, retry }
}
