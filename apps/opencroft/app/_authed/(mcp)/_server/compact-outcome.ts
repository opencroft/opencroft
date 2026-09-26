/**
 * How group_chat_compact waits for the compaction it asked for, and what it
 * says about how that ended.
 *
 * The tool is declared `async`, so it runs as a background task and the text
 * built here is that task's result — the notification the caller reads instead
 * of polling group_chat_compact_status. Its own module, with no server imports,
 * so the bounds and the wording are tested on a fake job.
 *
 * THE COMPACTION IS NEVER STOPPED FROM HERE. The timeout and the task's signal
 * end the WAIT; the job carries on under its own lifecycle in stream.ts, and
 * every answer that gives up says so, with the last state it saw.
 */

import type { ContextUsage } from '@/app/_authed/(extension-runtime)/_server/session-context-usage'
import type { ThreadCompactAck, ThreadCompactStatus } from '@/app/_authed/(group-chats)/_server/model'

/**
 * How long the tool waits for the job to end. Observed compactions take 2–8
 * minutes, and a job can also sit `pending` behind a long turn in the thread,
 * so this leaves a margin. It stays below the background task's own limit
 * (DEFAULT_TIMEOUT_MINUTES), so the wait always ends with this module's answer
 * rather than a bare expiry that says nothing about the compaction.
 */
export const COMPACT_WAIT_MS = 15 * 60_000

/** What the tool waits on — `ThreadCompactWatch`, narrowed to what the wait reads. */
export interface CompactWaitable {
  status: () => ThreadCompactStatus
  settled: Promise<ThreadCompactStatus>
}

/** How the wait ended, and the job's status at that moment. */
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

/** The task's result text, and whether the task should read as failed. */
export interface CompactOutcome {
  text: string
  failed: boolean
}

function tokens(n: number): string {
  return n.toLocaleString('en-US')
}

function usageText(usage: ContextUsage | null | undefined): string {
  if (!usage) {
    return 'unknown'
  }
  return usage.contextLimit === null
    ? `${tokens(usage.usedTokens)} tokens`
    : `${tokens(usage.usedTokens)} of ${tokens(usage.contextLimit)} tokens`
}

function instant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`
}

/** A job not yet ended, as a reader can act on it. */
function inFlightText(status: ThreadCompactStatus): string {
  if (status.state === 'running') {
    return status.startedAt === undefined ? 'running' : `running since ${instant(status.startedAt)}`
  }
  if (status.state === 'pending') {
    return "pending — waiting for the thread's current turn to end"
  }
  return status.state
}

/** The first line for a job that has ended. */
function endedHeadline(thread: string, status: ThreadCompactStatus): CompactOutcome {
  if (status.state === 'error') {
    return { failed: true, text: `Compaction of thread "${thread}" failed: ${status.error ?? 'no reason was given'}.` }
  }
  const result = status.result
  const usage = `context ${usageText(result?.contextUsageBefore)} → ${usageText(result?.contextUsageAfter)}`
  // The known case: the job ends `done` while the context did not shrink.
  // Said first and in capitals, because a caller that only glances at the
  // notification must not take it for a compaction.
  if (result?.compacted === false) {
    return {
      failed: false,
      text:
        `Thread "${thread}" was NOT compacted: the job finished, but its context did not shrink (${usage}). ` +
        'Its standing context was not re-sent either, because nothing was dropped. ' +
        'Call group_chat_compact again to retry.',
    }
  }
  const restored = result?.instructionsRestored
    ? "The thread's standing context (topic and pins) was re-delivered and read."
    : "The thread's standing context was NOT confirmed as re-delivered: there was none to send, or the session did not finish reading it."
  if (result?.compacted === true) {
    return { failed: false, text: `Compacted thread "${thread}": ${usage}. ${restored}` }
  }
  return {
    failed: false,
    text:
      `Could not tell whether thread "${thread}" was compacted: the job finished, but its context usage ` +
      `was not reported on both sides (${usage}). Do not read this as success. ${restored}`,
  }
}

/**
 * What group_chat_compact answers with once its wait is over: one plain
 * headline, then the job's status as JSON, the same shape
 * group_chat_compact_status returns — `compacted`, `instructionsRestored`,
 * the usage before and after, and the error.
 *
 * A job that failed, and a wait that gave up before the job ended, fail the
 * task: neither is a compaction, and a failed notification is the one a caller
 * cannot mistake for one. `compacted: false` does not fail it — the job did
 * what it could and ended cleanly — but its headline says it plainly.
 */
export function compactOutcome(ack: ThreadCompactAck, wait: CompactWait, opts: { timeoutMs: number }): CompactOutcome {
  const { thread } = ack
  const { status } = wait
  // Checked by the status rather than by how the wait ended: a job that
  // settles in the same instant the wait gives up has still ended.
  let outcome: CompactOutcome
  if (status.state === 'done' || status.state === 'error') {
    outcome = endedHeadline(thread, status)
  } else if (wait.ended === 'aborted') {
    outcome = {
      failed: true,
      text:
        `Stopped waiting for the compaction of thread "${thread}": this task was cancelled. ` +
        `The compaction itself was not stopped; last known state: ${inFlightText(status)}. ` +
        'group_chat_compact_status shows when it ends.',
    }
  } else {
    outcome = {
      failed: true,
      text:
        `Compaction of thread "${thread}" did not finish within ${minutes(opts.timeoutMs)}; ` +
        `last known state: ${inFlightText(status)}. The job was not stopped and carries on — ` +
        'group_chat_compact_status shows when it ends. Send nothing into the thread before then.',
    }
  }
  const joined = ack.coalesced ? ' This call joined a compaction of the thread that was already in progress.' : ''
  return { failed: outcome.failed, text: `${outcome.text}${joined}\n\n${JSON.stringify(status)}` }
}
