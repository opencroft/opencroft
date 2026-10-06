/**
 * Waiting for a thread's compaction to end, for a caller that asked for one
 * and needs its outcome: the group_chat_compact tool, and an extension's
 * `groupChats.compact`. Its own module, with no server imports, so the bound
 * is tested on a fake job.
 *
 * THE COMPACTION IS NEVER STOPPED FROM HERE. The timeout and the signal end
 * the WAIT; the job carries on under its own lifecycle in stream.ts.
 */

import type { HostCompactResult } from '@opencroft/server'

import type { ThreadCompactStatus } from '@/app/_authed/(group-chats)/_server/model'

/**
 * How long a caller waits for the job to end. Observed compactions take 2–8
 * minutes, and a job can also sit `pending` behind a long turn in the thread,
 * so this leaves a margin. It stays below an MCP background task's own limit
 * (DEFAULT_TIMEOUT_MINUTES), so group_chat_compact's wait always ends with its
 * own answer rather than a bare expiry that says nothing about the compaction.
 */
export const COMPACT_WAIT_MS = 15 * 60_000

/** What a caller waits on — `ThreadCompactWatch`, narrowed to what the wait reads. */
export interface CompactWaitable {
  status: () => ThreadCompactStatus
  settled: Promise<ThreadCompactStatus>
}

/**
 * How the wait ended, and the job's status at that moment. Read the status
 * to tell whether the job ended: one that settles in the same instant the wait
 * gives up has still ended.
 */
export interface CompactWait {
  ended: 'settled' | 'timeout' | 'aborted'
  status: ThreadCompactStatus
}

/**
 * Wait for the job to reach `done` or `error`, for at most `timeoutMs`, and no
 * longer than `signal` stays unaborted. Never rejects: a job's failure is its
 * status, not an exception.
 */
export async function waitForCompact(
  watch: CompactWaitable,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<CompactWait> {
  const { timeoutMs, signal } = opts
  if (signal?.aborted) {
    return { ended: 'aborted', status: watch.status() }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const givenUp = new Promise<'timeout' | 'aborted'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    onAbort = () => resolve('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([
      watch.settled.then((status): CompactWait => ({ ended: 'settled', status })),
      givenUp.then((ended): CompactWait => ({ ended, status: watch.status() })),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * The job's status at the end of a wait, as an extension's
 * `groupChats.compact` answers it. Judged by the status, not by how the wait
 * ended, for the reason `CompactWait` gives.
 */
export function compactResultOf(status: ThreadCompactStatus): HostCompactResult {
  const contextBefore = status.result?.contextUsageBefore?.usedTokens ?? null
  const contextAfter = status.result?.contextUsageAfter?.usedTokens ?? null
  if (status.state === 'error') {
    return { outcome: 'failed', contextBefore, contextAfter, error: status.error ?? 'The compaction failed' }
  }
  if (status.state !== 'done') {
    return { outcome: 'timed_out', contextBefore, contextAfter }
  }
  const compacted = status.result?.compacted ?? null
  return {
    outcome: compacted === null ? 'unknown' : compacted ? 'compacted' : 'not_compacted',
    contextBefore,
    contextAfter,
  }
}
