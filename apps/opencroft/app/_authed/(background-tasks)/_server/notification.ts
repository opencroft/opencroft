// What a session is told about a background task, in its two forms: the record
// its chat draws (the task card in the transcript, the strip above the
// composer), and the notification its agent reads when the task ends. Words
// only; delivery.ts is what gets them there.

import type { HostAsyncTaskInfo } from './engine'
import type { BackgroundTaskRecord } from './types'

/** How long a finished node task's directory — its full log — stays on the node once told. */
export const LOG_RETENTION_DAYS = 3

const TAG = 'opencroft-background-task'

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A time limit as a person set it: whole minutes when it is whole minutes. */
export function formatLimit(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : formatDuration(ms)
}

function tookMs(record: BackgroundTaskRecord): number {
  return (record.finishedAt ?? record.startedAt).getTime() - record.startedAt.getTime()
}

/** The card's second line: where the task stands, in a reader's words. */
export function statusLine(record: BackgroundTaskRecord): string {
  const took = formatDuration(tookMs(record))
  if (record.state === 'running') {
    const limit = record.timeoutMs === null ? 'no time limit' : `stops after ${formatLimit(record.timeoutMs)}`
    return `Running on ${record.target} · ${limit}`
  }
  if (record.state === 'completed') {
    return `Completed in ${took}`
  }
  if (record.state === 'failed') {
    return record.exitCode === undefined
      ? `Failed after ${took}: ${record.reason ?? 'no reason recorded'}`
      : `Failed with exit code ${record.exitCode} after ${took}`
  }
  return `Stopped after ${took}: ${record.reason ?? 'no reason recorded'}`
}

/**
 * The task as the chat draws it. Always the whole record: the engine replaces
 * what it holds with what it is given, so a field left out here would be
 * cleared there. The title says what the task is, the second line where it
 * stands; the log path is where its full output lives.
 */
export function asyncTaskInfo(record: BackgroundTaskRecord): HostAsyncTaskInfo {
  return {
    asyncTaskId: record.taskId,
    name: record.summary || `${record.name} on ${record.target}`,
    taskType: record.name,
    description: `${record.name} on ${record.target}`,
    state: record.state,
    canStop: record.state === 'running',
    showInTranscript: true,
    summary: statusLine(record),
    outputFilePath: record.logPath,
    origin: 'host',
  }
}

// A closing `</opencroft-…>` anywhere inside — a log line can hold one — would
// end the hidden block early, and everything after it would show as the
// reader's own words. The strip that hides the block matches closing tags
// only in that exact form, so a backslash is enough to break one.
function neutralise(text: string): string {
  return text.replace(/<\/(opencroft-)/gi, '<\\/$1')
}

function outcome(record: BackgroundTaskRecord): string {
  if (record.exitCode !== undefined) {
    return `${record.state}, exit code ${record.exitCode}${record.reason ? ` (${record.reason})` : ''}`
  }
  return record.reason ? `${record.state}: ${record.reason}` : record.state
}

/**
 * What the calling session's agent is told when its task ends. Everything it
 * needs to act without asking: what ran and where, how it ended, how long it
 * took, the end of its output, and how to read the rest.
 *
 * Wrapped in a bare `<opencroft-background-task>` tag — no attributes. The chat
 * hides exactly that form (see `userText` in the agent route's build-blocks),
 * and a turn that is nothing but such a tag draws no bubble: that is what keeps
 * this out of the reader's view. A tag with attributes would show as a message.
 */
export function notificationText(record: BackgroundTaskRecord): string {
  const lines = [
    `Background task ${record.taskId} has ended: ${record.state}.`,
    `Task: ${record.summary}`,
    `Ran: ${record.name} on ${record.target} (${record.kind})`,
    `Outcome: ${outcome(record)}`,
    `Took: ${formatDuration(tookMs(record))}, started ${record.startedAt.toISOString()}`,
  ]
  const label = record.kind === 'tool' ? 'Output (the end of it)' : 'Result'
  lines.push(record.outputTail ? `${label}:\n${record.outputTail.replace(/\n$/, '')}` : `${label}: (none)`)
  if (record.logPath) {
    lines.push(
      `The full log is ${record.logPath} on ${record.target}, kept there for ${LOG_RETENTION_DAYS} days: ` +
        `read it with remote_read, target "${record.target}", path "${record.logPath}".`,
    )
  }
  return `<${TAG}>\n${neutralise(lines.join('\n'))}\n</${TAG}>`
}
