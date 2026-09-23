/**
 * How a tool or an action tells its caller it can run in the background: through
 * its input schema and its description, and through nothing else.
 *
 * THE SCHEMA IS THE ONLY SIGNAL (product decision). `execution` is how a tool
 * family or a manifest declares the mode; it is never shown to a caller, because
 * a caller that has to learn one more field in order to read the schema it
 * already reads is being asked to do the host's bookkeeping. So:
 *
 *   - `awaitable` gains the two parameters that choose the mode per call;
 *   - `async` gains one sentence and keeps exactly the schema a `sync` one would
 *     have — the call asks nothing new, only answers later;
 *   - `sync` is left as it was declared.
 *
 * Every listing presents through here — the tool list both the HTTP surface and
 * the in-process bridge serve, static, extension-contributed and graph-defined
 * tools alike, and `list_actions` and `app_actions` — so each says the same
 * thing in the same words.
 */

import type { ExecutionMode } from '@opencroft/core'

/**
 * The two parameters an `awaitable` tool or action gains. Named, because the
 * handlers read exactly what the schema offers, and a caller's `background` on
 * anything else is that caller's own parameter.
 */
export const BACKGROUND_PARAM = 'background'
export const TIMEOUT_MINUTES_PARAM = 'timeoutMinutes'

/**
 * How long a background task may run when its caller does not say. Here, in a
 * module with no server imports, because the approval view states it too: the
 * person approving a detached command reads the same limit the service
 * enforces, not a copy of it.
 */
export const DEFAULT_TIMEOUT_MINUTES = 60

/**
 * How a backgrounded call's run reads to the person approving it, or undefined
 * for a call that runs in place. Detached work outlives the call that started
 * it, and one with no time limit is a bigger thing to say yes to than a
 * two-minute command — so the approval says which it is.
 */
export function backgroundRunLabel(args: Record<string, unknown>): string | undefined {
  if (args[BACKGROUND_PARAM] !== true) {
    return undefined
  }
  const minutes = args[TIMEOUT_MINUTES_PARAM]
  if (minutes === undefined) {
    return `In the background, stopped after ${DEFAULT_TIMEOUT_MINUTES} min`
  }
  if (minutes === 0) {
    return 'In the background, with no time limit'
  }
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
    return `In the background, stopped after ${minutes} min`
  }
  // The handler refuses this after approval; showing the default here would
  // have the approver agree to a limit the call never had.
  return `In the background, with an invalid time limit (${JSON.stringify(minutes)}) — the call will be refused`
}

export const BACKGROUND_PROPERTIES = {
  [BACKGROUND_PARAM]: {
    type: 'boolean',
    description:
      'Run detached: returns a task id at once and this conversation is told when it finishes. Use it for anything that may outlast ~2 minutes — builds, test suites, deploys, downloads, image pulls.',
  },
  [TIMEOUT_MINUTES_PARAM]: {
    type: 'number',
    description: 'Background only. Default 60; 0 = no limit.',
  },
} as const

/** The one sentence an `awaitable` tool's description gains. */
export const AWAITABLE_SENTENCE =
  'Pass `background: true` for anything that may outlast ~2 minutes: the call returns a task id at once, and the result arrives in this conversation when it ends.'

/** The one sentence an `async` tool's or action's description gains. */
export const ASYNC_SENTENCE =
  'Runs as a background task: the call returns a task id at once, and the result arrives in this conversation when it ends.'

/**
 * A mode read from where nothing checked it — a manifest entry, an agent-tool
 * node's data — as one of the three, or undefined. Anything else is
 * undeclared, which is `sync`: a misspelt mode must not reach the registry as
 * though it were one, and the listing and the dispatch have to read the same
 * answer from the same value.
 */
export function readExecutionMode(value: unknown): ExecutionMode | undefined {
  return value === 'sync' || value === 'awaitable' || value === 'async' ? value : undefined
}

/** A tool as its family declares it: what a caller is shown, and how a caller waits for it. */
export interface DeclaredTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execution?: ExecutionMode
}

/** A tool as a caller receives it. */
export interface ListedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** The fields of an action declaration this module reads. Everything else passes through. */
export interface ActionDeclaration {
  description?: string
  inputSchema?: Record<string, unknown>
  execution?: ExecutionMode
}

function withSentence(description: string | undefined, sentence: string): string {
  const text = description?.trim() ?? ''
  if (!text) {
    return sentence
  }
  return /[.!?]$/.test(text) ? `${text} ${sentence}` : `${text}. ${sentence}`
}

// An action may declare no schema at all; one that runs in the background by
// choice still has these two to offer.
function withBackgroundProperties(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = schema ?? { type: 'object' }
  const properties = (base.properties as Record<string, unknown> | undefined) ?? {}
  return { ...base, properties: { ...properties, ...BACKGROUND_PROPERTIES } }
}

/** A tool definition as every surface lists it. */
export function presentTool(tool: DeclaredTool): ListedTool {
  const { execution, ...listed } = tool
  if (execution === 'awaitable') {
    return {
      ...listed,
      description: withSentence(listed.description, AWAITABLE_SENTENCE),
      inputSchema: withBackgroundProperties(listed.inputSchema),
    }
  }
  if (execution === 'async') {
    return { ...listed, description: withSentence(listed.description, ASYNC_SENTENCE) }
  }
  return listed
}

/**
 * An action declaration as `list_actions` and `app_actions` print it: every
 * field it came with except `execution`, which is said through the schema and
 * description instead. Unlike a tool, an `awaitable` action gains the two
 * parameters and no sentence — its listing is read for what it takes.
 */
export function presentAction<T extends ActionDeclaration>(action: T): Omit<T, 'execution'> {
  const { execution, ...listed } = action
  if (execution === 'awaitable') {
    return { ...listed, inputSchema: withBackgroundProperties(action.inputSchema) }
  }
  if (execution === 'async') {
    return { ...listed, description: withSentence(action.description, ASYNC_SENTENCE) }
  }
  return listed
}
