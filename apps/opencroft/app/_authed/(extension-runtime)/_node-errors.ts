// A node's errors as its data stores them, read and written the same way by the
// server (node actions, `graph.setNodeErrors`) and the canvas (the card's
// indicator, the inspector's Errors tab). Host-free, so tests load it directly.

import type { NodeError, NodeErrorEntry } from '@opencroft/core'

/** The key of a node's data that holds its errors. */
export const NODE_ERRORS_KEY = '__errors'

/** The host's own source: the failure of the last node action, cleared when the next one starts. */
export const ACTION_ERROR_SOURCE = 'action'

/** The host's own source: what the node type's data validator finds in the node's data now. */
export const DATA_ERROR_SOURCE = 'data'

/** The host's own source: what the node type's check finds in the node's data and wiring now. */
export const CHECK_ERROR_SOURCE = 'check'

const OPTIONAL_FIELDS = ['detail', 'code', 'next', 'path'] as const

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * `value` as a node error, keeping only its fields that hold text; undefined
 * when it has no title. What an extension reported or threw is checked here
 * rather than trusted, because it is stored on the node and read by agents.
 */
export function nodeErrorOf(value: unknown): NodeError | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const title = textOf(record.title)
  if (!title) {
    return undefined
  }
  const error: NodeError = { title }
  for (const field of OPTIONAL_FIELDS) {
    const text = textOf(record[field])
    if (text) {
      error[field] = text
    }
  }
  return error
}

function entryOf(value: unknown): NodeErrorEntry | undefined {
  // A string entry is an action failure stored as its message alone, a form
  // stored graphs can hold.
  if (typeof value === 'string') {
    return textOf(value) ? { source: ACTION_ERROR_SOURCE, title: value } : undefined
  }
  const error = nodeErrorOf(value)
  if (!error) {
    return undefined
  }
  const source = textOf((value as Record<string, unknown>).source) ?? ACTION_ERROR_SOURCE
  return { source, ...error }
}

/** The errors stored in a node's data, in the order they were reported. */
export function readNodeErrors(data: Record<string, unknown> | undefined): NodeErrorEntry[] {
  const stored = data?.[NODE_ERRORS_KEY]
  if (!Array.isArray(stored)) {
    return []
  }
  return stored.map(entryOf).filter((entry): entry is NodeErrorEntry => entry !== undefined)
}

/**
 * `data` with `source`'s errors replaced by `errors`, the other sources' kept.
 * Returns `data` itself when that changes nothing, so a caller can skip the
 * write: a check that reports on every run then writes only when its answer
 * changes. Where `source`'s errors sit in the list is not a change: two
 * sources that each report on every graph change would otherwise move each
 * other's entries to the end and rewrite the node forever.
 */
export function withNodeErrors(
  data: Record<string, unknown>,
  source: string,
  errors: readonly NodeError[],
): Record<string, unknown> {
  const current = readNodeErrors(data)
  const reported = errors
    .map(nodeErrorOf)
    .filter((error): error is NodeError => error !== undefined)
    .map((error) => ({ source, ...error }))
  const next = [...current.filter((entry) => entry.source !== source), ...reported]
  if (next.length === 0) {
    if (!(NODE_ERRORS_KEY in data)) {
      return data
    }
    const { [NODE_ERRORS_KEY]: _, ...rest } = data
    return rest
  }
  const own = current.filter((entry) => entry.source === source)
  if (JSON.stringify(own) === JSON.stringify(reported)) {
    return data
  }
  return { ...data, [NODE_ERRORS_KEY]: next }
}

/** The source of the errors a node type derives on the open canvas (`NodeDefinition.errors`). */
const CANVAS_ERROR_SOURCE = 'canvas'

function sameError(a: NodeError, b: NodeError): boolean {
  return a.title === b.title && a.detail === b.detail && a.code === b.code && a.next === b.next
}

/**
 * `stored` followed by the errors a node type derived on the canvas, each
 * checked as `nodeErrorOf` checks it. A derived error already stored (an
 * action refused for the same reason) is left out, so it shows once.
 */
export function withDerivedErrors(stored: NodeErrorEntry[], derived: readonly unknown[]): NodeErrorEntry[] {
  return [
    ...stored,
    ...derived.flatMap((value) => {
      const error = nodeErrorOf(value)
      return error && !stored.some((entry) => sameError(entry, error))
        ? [{ source: CANVAS_ERROR_SOURCE, ...error }]
        : []
    }),
  ]
}

/**
 * `data` with `source`'s errors replaced by `errors`, leaving out each one
 * another source already reports on the node, so it shows once. Returns
 * `data` itself when that changes nothing, as `withNodeErrors` does.
 */
export function withErrorsShownOnce(
  data: Record<string, unknown>,
  source: string,
  errors: readonly NodeError[],
): Record<string, unknown> {
  const elsewhere = readNodeErrors(data).filter((entry) => entry.source !== source)
  return withNodeErrors(
    data,
    source,
    errors.filter((error) => !elsewhere.some((entry) => sameError(entry, error))),
  )
}

/**
 * `data` with its action error set to `error`, or cleared when it is undefined.
 * An error another source already reports on the node is not stored again: an
 * extension that records a failure under its own source and also throws it
 * would otherwise show it twice.
 */
export function withActionError(data: Record<string, unknown>, error: NodeError | undefined): Record<string, unknown> {
  return withErrorsShownOnce(data, ACTION_ERROR_SOURCE, error ? [error] : [])
}

/** The problem an error was thrown with, when it carries one (see `NodeActionHandler`). */
export function problemOf(err: unknown): NodeError | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined
  }
  return nodeErrorOf((err as { problem?: unknown }).problem)
}

/** What a failed node action records: the problem it threw, or its message under the action's name. */
export function actionFailure(actionLabel: string, err: unknown): NodeError {
  const problem = problemOf(err)
  if (problem) {
    return problem
  }
  const message = err instanceof Error ? err.message : String(err)
  return { title: `${actionLabel} failed`, ...(textOf(message) ? { detail: message } : {}) }
}

/**
 * `err` carrying `problem`, so whoever catches a failed node action (an
 * agent's `call`) reads what the node recorded. An error stays itself, since
 * other callers read its message; anything else thrown becomes an error with
 * its text as the message.
 */
export function withProblem(err: unknown, problem: NodeError): Error {
  return Object.assign(err instanceof Error ? err : new Error(String(err)), { problem })
}
