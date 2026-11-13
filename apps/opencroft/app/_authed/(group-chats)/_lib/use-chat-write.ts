'use client'

import { useState } from 'react'

import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { memberActionRefusal } from '@/app/_authed/(group-chats)/_lib/member-action-refusal'
import type { GroupChatWriteResult } from '@/app/_authed/(group-chats)/_server/actions'

/** One group of a dialog's writes: whether one is under way, why the last was refused, and how many have settled. */
export interface ChatWrite {
  /** Runs `action`, then reloads the chat when it went through. `fallback` is the copy for a fault that names no reason. */
  run: (action: () => Promise<GroupChatWriteResult>, fallback: string) => void
  pending: boolean
  error: string | undefined
  /** Counts settled writes, succeeded or not, for a reader to read its list again after each. */
  settled: number
}

/**
 * A dialog section's writes. A refusal (the last user member, a removed
 * principal, ...) comes back as DATA -- `{ ok: false, code }` -- and is shown
 * in the server's own words; `catch` is for genuine faults, which still throw.
 * Each section holds its own, so a refusal is shown in the section that made
 * it and a write under way disables only that section's controls.
 */
export function useChatWrite(refresh: () => Promise<void>): ChatWrite {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [settled, setSettled] = useState(0)
  const run = (action: () => Promise<GroupChatWriteResult>, fallback: string) => {
    setError(undefined)
    setPending(true)
    void (async () => {
      try {
        const refusal = memberActionRefusal(await action())
        if (refusal) {
          setError(refusal)
          return
        }
        // The dialog stays open: managing several in a row is the common
        // case, and the lists re-draw once the data refreshes.
        await refresh()
      } catch (e) {
        setError(failureMessage(e, fallback))
      } finally {
        setPending(false)
        setSettled((n) => n + 1)
      }
    })()
  }
  return { run, pending, error, settled }
}
