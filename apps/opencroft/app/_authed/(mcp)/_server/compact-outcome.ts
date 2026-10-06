/**
 * What group_chat_compact says about how the compaction it waited for ended
 * (the wait itself is ../../(group-chats)/_server/compact-wait.ts).
 *
 * The tool is declared `async`, so it runs as a background task and the text
 * built here is that task's result — the notification the caller reads instead
 * of polling group_chat_compact_status. Its own module, with no server imports,
 * so the wording is tested on a fake job. Every answer that gives up says the
 * compaction itself carries on, with the last state it saw.
 */

import type { ContextUsage } from '@/app/_authed/(extension-runtime)/_server/session-context-usage'
import type { CompactWait } from '@/app/_authed/(group-chats)/_server/compact-wait'
import type { ThreadCompactAck, ThreadCompactStatus } from '@/app/_authed/(group-chats)/_server/model'

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
