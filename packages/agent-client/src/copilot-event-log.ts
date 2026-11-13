// The Copilot CLI (1.0.95) settles a turn whose model call failed as an
// ordinary `end_turn`: after its retries it sends the failure as reply text,
// `Error: <message>`, and nothing on the ACP wire marks it — no `_meta`, no
// stop reason, nothing on stderr, whatever capabilities the client declares.
// A wrong key or an unreachable endpoint therefore reads as the agent's
// answer.
//
// The CLI does record the failure, typed, in its own per-session event log:
// a `session.error` event (`errorType`, `statusCode`, `message`) in
// `<COPILOT_HOME>/session-state/<sessionId>/events.jsonl`, whose shape the
// package ships as `schemas/session-events.schema.json`. It is written before
// the prompt response goes out, so it is there when the turn settles. This
// module reads that one event and nothing else from the log.
//
// Every read fails soft: a log that is missing, unreadable or shaped
// differently answers `undefined`, and the turn keeps the reply text the
// harness sent.

import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TurnFailureLog } from './turn-failure-log'
import type { SessionFailure } from './types'

const REPLY_PREFIX = 'Error: '

// The failure is the last thing a failed turn logs, while a turn's slice can
// hold whole tool outputs, so only the end of the slice is read. 64 KiB holds
// the error event with its stack and the turn-end events around it many times
// over.
const TAIL_BYTES = 64 * 1024

// Session ids are the CLI's own UUIDs; anything else is not joined into a path.
const SESSION_ID = /^[A-Za-z0-9-]+$/

interface FailureShape {
  label: string
  category: string
  actions: string[]
  title: string
}

// Copilot's `errorType`s (the schema's ErrorData), named in the vocabulary
// parseSessionFailure derives for the bridges' typed verdicts.
const FAILURE_BY_ERROR_TYPE: Record<string, FailureShape> = {
  authentication: {
    label: 'auth_required',
    category: 'access',
    actions: ['login'],
    title: 'The model provider refused the credentials',
  },
  authorization: {
    label: 'access_denied',
    category: 'access',
    actions: ['retry'],
    title: 'The model provider denied access',
  },
  quota: { label: 'quota_exhausted', category: 'limit', actions: [], title: 'The model quota is exhausted' },
  rate_limit: {
    label: 'rate_limited',
    category: 'limit',
    actions: ['retry'],
    title: 'The model provider is limiting requests',
  },
  context_limit: {
    label: 'limit',
    category: 'limit',
    actions: ['new_session'],
    title: "The conversation no longer fits the model's context window",
  },
}

// `query` (an endpoint that errored or could not be reached) and any type the
// schema adds later.
const OTHER_FAILURE: FailureShape = {
  label: 'service',
  category: 'service',
  actions: ['retry'],
  title: 'The model call failed',
}

function logPath(home: string, sessionId: string): string | undefined {
  return SESSION_ID.test(sessionId) ? join(home, 'session-state', sessionId, 'events.jsonl') : undefined
}

function mark(home: string, sessionId: string): number {
  const path = logPath(home, sessionId)
  if (!path) {
    return 0
  }
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function readTail(path: string, from: number): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    // A log shorter than the mark was replaced underneath the session; its
    // whole tail is then this turn's.
    const start = Math.max(size < from ? 0 : from, size - TAIL_BYTES)
    if (size <= start) {
      return undefined
    }
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** The last `session.error` in a slice of the log, as the typed failure and the reply text the CLI sent for it. */
export function lastSessionError(slice: string): { reply: string; failure: SessionFailure } | undefined {
  const lines = slice.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    let event: Record<string, unknown> | undefined
    try {
      event = asRecord(JSON.parse(lines[index]))
    } catch {
      // A tail cut mid-line, or a line still being written.
      continue
    }
    if (event?.type !== 'session.error') {
      continue
    }
    const data = asRecord(event.data)
    const message = typeof data?.message === 'string' ? data.message : undefined
    const errorType = typeof data?.errorType === 'string' ? data.errorType : undefined
    if (!message || !errorType) {
      return undefined
    }
    const shape = Object.hasOwn(FAILURE_BY_ERROR_TYPE, errorType) ? FAILURE_BY_ERROR_TYPE[errorType] : OTHER_FAILURE
    const status = typeof data?.statusCode === 'number' ? ` (HTTP ${data.statusCode})` : ''
    return {
      reply: `${REPLY_PREFIX}${message}`,
      failure: {
        id: typeof event.id === 'string' ? event.id : `copilot-${errorType}`,
        label: shape.label,
        kind: errorType,
        title: `${shape.title}${status}`,
        category: shape.category,
        severity: 'error',
        details: message,
        actions: shape.actions,
      },
    }
  }
  return undefined
}

export const COPILOT_FAILURE_LOG: TurnFailureLog = {
  replyPrefix: REPLY_PREFIX,
  mark,
  read(home, sessionId, from) {
    const path = logPath(home, sessionId)
    const slice = path ? readTail(path, from) : undefined
    return slice ? lastSessionError(slice) : undefined
  },
}
