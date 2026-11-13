/**
 * Whether a request may reach an API Route's handler, by the header the
 * route's node requires (`api-route-protection.ts`).
 *
 * The required value is resolved per request, so a rotated secret takes
 * effect on the next call, and compared in constant time. A refusal says only
 * that the request is unauthorized, never which header or value was wanted.
 * The handler receives the request's headers without the protecting one, so
 * the secret never reaches the script.
 *
 * A route whose value cannot be checked stays shut and answers 500. A header
 * name no request can carry is the node's data problem, stored as its error
 * (`apiRouteDataProblems`). A value that cannot be resolved (a secret no store
 * holds, an empty one) is known only when a request meets it, so the check
 * reports it as the node's error under its own source, and the next request
 * that resolves the value clears it.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import type { NodeError } from '@opencroft/core'

import {
  type ApiRouteProtectionData,
  isHeaderName,
  PROTECTION_ERROR_SOURCE,
  presentedCredential,
  type RouteProtection,
  routeProtection,
  unresolvedValueError,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/api-route-protection'
import { withNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import { secrets } from '@/server/secrets'

export type RouteAccess =
  /** `headers` is what the handler receives: the request's, less the protecting header. */
  { allowed: true; headers: Record<string, string> } | { allowed: false; response: Response }

/** Turns a stored value (typed, or `secret:<NAME>`) into the value itself; throws when it cannot. */
export type ResolveValue = (stored: string) => Promise<string>

/** Replaces the errors the check reported on a node before (`graph.setNodeErrors`). */
export type ReportErrors = (nodeId: string, errors: NodeError[]) => Promise<void>

/** The route node's data as stored: its protection, its path and the errors it holds. */
export type RouteNodeData = ApiRouteProtectionData & { path?: string } & Record<string, unknown>

export interface RouteAccessDeps {
  resolve?: ResolveValue
  report?: ReportErrors
}

async function reportOnHost(nodeId: string, errors: NodeError[]): Promise<void> {
  // Imported on use: the host module loads the whole extension runtime.
  const { setNodeErrors } = await import('@/app/_authed/(extension-runtime)/_server/host')
  await setNodeErrors(nodeId, PROTECTION_ERROR_SOURCE, errors)
}

// Digests first: `timingSafeEqual` needs equal lengths, and comparing the
// lengths themselves would tell a caller how long the value is.
function sameValue(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function unauthorized(protection: RouteProtection): Response {
  const headers: Record<string, string> = protection.scheme ? { 'WWW-Authenticate': protection.scheme } : {}
  return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
}

function unavailable(nodeId: string, cause: string): RouteAccess {
  console.error(`[api-route] route ${nodeId} refused a request: ${cause}`)
  return {
    allowed: false,
    response: Response.json({ error: 'Route protection could not be checked' }, { status: 500 }),
  }
}

// Reads the node's stored errors first, so a request writes only when the
// answer changes: the first one that meets a missing secret, and the first
// one after it is back or the route is made open. A failed write is
// logged and does not change the request's answer.
async function reportValueErrors(
  nodeId: string,
  data: RouteNodeData | undefined,
  errors: NodeError[],
  report: ReportErrors,
): Promise<void> {
  const stored = data ?? {}
  if (withNodeErrors(stored, PROTECTION_ERROR_SOURCE, errors) === stored) {
    return
  }
  try {
    await report(nodeId, errors)
  } catch (err) {
    console.error(`[api-route] route ${nodeId} could not record its protection error:`, err)
  }
}

export async function checkRouteAccess(
  nodeId: string,
  data: RouteNodeData | undefined,
  requestHeaders: Headers,
  // From the Secrets Stores on the route node's own graph.
  { resolve = (stored) => secrets.resolveValue(stored, { nodeId }), report = reportOnHost }: RouteAccessDeps = {},
): Promise<RouteAccess> {
  const headers = Object.fromEntries(requestHeaders.entries())
  const protection = routeProtection(data)
  if (!protection) {
    await reportValueErrors(nodeId, data, [], report)
    return { allowed: true, headers }
  }
  if (!isHeaderName(protection.header)) {
    return unavailable(nodeId, `"${protection.header}" is not a header name a request can carry`)
  }
  let expected: string
  try {
    expected = await resolve(protection.token)
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    await reportValueErrors(nodeId, data, [unresolvedValueError(data?.path ?? '/', protection, cause)], report)
    return unavailable(nodeId, cause)
  }
  if (expected === '') {
    const cause = 'the required value is empty'
    await reportValueErrors(nodeId, data, [unresolvedValueError(data?.path ?? '/', protection, cause)], report)
    return unavailable(nodeId, cause)
  }
  await reportValueErrors(nodeId, data, [], report)
  const presented = presentedCredential(requestHeaders.get(protection.header), protection.scheme)
  if (presented === undefined || !sameValue(presented, expected)) {
    return { allowed: false, response: unauthorized(protection) }
  }
  // `Headers` yields lower-case names.
  delete headers[protection.header.toLowerCase()]
  return { allowed: true, headers }
}
