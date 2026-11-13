// What a node's data says about its wired inputs. The server's resolver writes
// each wired input's context under `__resolvedContexts` and lists a wired
// input whose source exposes nothing under `__unresolvedInputs`; of those, the
// ones that have a value only while a run dispatches are also listed under
// `__awaitingRun`. The canvas resolver hands a source's `exposeOutput` its data
// in the same shape, built from the open page's wiring. Whatever reads a
// node's inputs from its data reads them through here, so it reads them the
// same in both places.
//
// Host-free, so the host, its resolvers and the nodes that compute from their
// inputs read the same shape with the same code.

import type { WiredValue } from './types'

export const RESOLVED_CONTEXTS_KEY = '__resolvedContexts'
export const UNRESOLVED_INPUTS_KEY = '__unresolvedInputs'
/**
 * The wired inputs that expose nothing because nothing runs: fed from a
 * run-time output (a handle declared `runtime: true`), directly or through a
 * node that exposes nothing for want of one. A subset of `__unresolvedInputs`.
 */
export const AWAITING_RUN_KEY = '__awaitingRun'

/** One wired input's context, as `__resolvedContexts` holds it. */
export interface ResolvedInputEntry {
  sourceNodeId: string
  sourceHandleId: string
  /** The source handle's qualified handle type. */
  handleType: string
  value: unknown
}

/** The wired inputs' contexts in `data`, by target handle id. */
export function resolvedInputsOf(
  data: Readonly<Record<string, unknown>> | undefined,
): Record<string, ResolvedInputEntry> {
  const stored = data?.[RESOLVED_CONTEXTS_KEY]
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, ResolvedInputEntry>)
    : {}
}

/**
 * What is wired into `handleId` as `data` records it (see `WiredValue`): its
 * context's value, null when it is wired and its source exposes nothing, or
 * undefined when nothing is wired.
 */
export function wiredValueOf(data: Readonly<Record<string, unknown>> | undefined, handleId: string): WiredValue {
  const resolved = resolvedInputsOf(data)
  if (Object.hasOwn(resolved, handleId)) {
    return { value: resolved[handleId].value }
  }
  const unresolved = data?.[UNRESOLVED_INPUTS_KEY]
  return Array.isArray(unresolved) && unresolved.includes(handleId) ? null : undefined
}

/** The wired inputs of `data` that have a value only while a run dispatches (see `AWAITING_RUN_KEY`). */
export function awaitingRunOf(data: Readonly<Record<string, unknown>> | undefined): string[] {
  const stored = data?.[AWAITING_RUN_KEY]
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
}

/**
 * `data` with its wired inputs replaced by `resolved`, `unresolved` and, of
 * those, `awaitingRun`, in the shape the server's resolver writes; an empty
 * key is left out.
 */
export function withWiredInputs(
  data: Readonly<Record<string, unknown>>,
  resolved: Readonly<Record<string, ResolvedInputEntry>>,
  unresolved: readonly string[],
  awaitingRun: readonly string[] = [],
): Record<string, unknown> {
  const { [RESOLVED_CONTEXTS_KEY]: _, [UNRESOLVED_INPUTS_KEY]: __, [AWAITING_RUN_KEY]: ___, ...rest } = data
  return {
    ...rest,
    ...(Object.keys(resolved).length > 0 ? { [RESOLVED_CONTEXTS_KEY]: resolved } : {}),
    ...(unresolved.length > 0 ? { [UNRESOLVED_INPUTS_KEY]: [...unresolved] } : {}),
    ...(awaitingRun.length > 0 ? { [AWAITING_RUN_KEY]: [...awaitingRun] } : {}),
  }
}
