// ═══════════════════════════════════════════════════════════════════
// Which header an API Route requires, and in what form
//
// A route is open until its node holds a value in `authToken`. Then every
// request must carry the header `authHeader` names (`Authorization` when
// blank) with that value. On `Authorization` the value comes after the
// `Bearer` scheme; on any other header it is the whole header value.
//
// `authToken` is typed text or `secret:<NAME>`, resolved on the server per
// request. The name ends in `Token` so a node read hides a typed value
// (`redact-node-data.ts`, rule 1) and returns a secret reference as it is.
//
// Host-free, so the inspector and the server read the same rules.
// ═══════════════════════════════════════════════════════════════════

import type { NodeDataProblem, NodeError } from '@opencroft/core'

export const DEFAULT_AUTH_HEADER = 'Authorization'

/** The fields of an API Route's data that protect it. */
export interface ApiRouteProtectionData {
  /** The header a request must carry; blank or absent means `Authorization`. */
  authHeader?: string
  /** Typed text or `secret:<NAME>`; blank or absent leaves the route open. */
  authToken?: string
}

export interface ProtectionHeader {
  /** The header name as configured, trimmed. */
  header: string
  /** `Bearer` on `Authorization`, otherwise none: the header value is the credential. */
  scheme: 'Bearer' | undefined
}

export interface RouteProtection extends ProtectionHeader {
  /** The stored value: typed text or `secret:<NAME>`, not yet resolved. */
  token: string
}

/** The header a route's data names, whether or not a value protects it yet. */
export function protectionHeader(data: ApiRouteProtectionData | undefined): ProtectionHeader {
  const named = typeof data?.authHeader === 'string' ? data.authHeader.trim() : ''
  const header = named || DEFAULT_AUTH_HEADER
  const scheme = header.toLowerCase() === DEFAULT_AUTH_HEADER.toLowerCase() ? 'Bearer' : undefined
  return { header, scheme }
}

// An HTTP field name: one token (RFC 9110, 5.1). A name outside it can never
// arrive on a request, so a route protected by one could never be called.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Whether a request can carry a header of this name. */
export function isHeaderName(name: string): boolean {
  return HEADER_NAME.test(name)
}

/**
 * What is wrong with a route's header name, or undefined when a request can
 * carry it. An open route never reads the header, but the name is told all
 * the same: the Errors tab is the only place that says why the Header field
 * is marked, and setting a value would make every request fail.
 */
export function headerNameError(data: ApiRouteProtectionData | undefined): NodeDataProblem | undefined {
  const { header } = protectionHeader(data)
  if (isHeaderName(header)) {
    return undefined
  }
  return {
    title: 'Header name no request can carry',
    detail: routeProtection(data)
      ? `"${header}" is not a header name, so this route answers every request with 500.`
      : `"${header}" is not a header name. The route is open now; once Value is set, it answers every request with 500.`,
    next: 'Set Header to letters, digits and dashes, such as X-Api-Key, or leave it blank for Authorization.',
    path: 'authHeader',
  }
}

/**
 * The API Route's data validator (`nodeDataValidators`): a graph write that
 * gives a route a header name no request can carry is refused, and a route
 * holding one shows it as its error.
 */
export function apiRouteDataProblems(data: ApiRouteProtectionData | undefined): NodeDataProblem[] {
  const error = headerNameError(data)
  return error ? [error] : []
}

/** The node error source a request's check reports an unresolvable value under. */
export const PROTECTION_ERROR_SOURCE = 'protection'

const SECRET_PREFIX = 'secret:'

/**
 * The node error for a protected route whose value could not be resolved
 * when a request arrived. `cause` is the resolver's message, which names the
 * secret and never holds a value.
 */
export function unresolvedValueError(path: string, protection: RouteProtection, cause: string): NodeError {
  const secretName = protection.token.startsWith(SECRET_PREFIX)
    ? protection.token.slice(SECRET_PREFIX.length)
    : undefined
  return {
    title: 'Protecting value not available',
    detail: `Every request to ${path} gets 500: ${cause}.`,
    next: secretName
      ? `Add ${secretName} to a Secrets Store on this graph, or pick another secret in Value. The next request that finds it clears this error.`
      : 'Set Value again. The next request that finds it clears this error.',
  }
}

/** The protection a route's data asks for, or undefined for an open route. */
export function routeProtection(data: ApiRouteProtectionData | undefined): RouteProtection | undefined {
  const token = typeof data?.authToken === 'string' ? data.authToken : ''
  if (token.trim() === '') {
    return undefined
  }
  return { ...protectionHeader(data), token }
}

/**
 * The credential a request presents in a header value, or undefined when the
 * value is not in the required form. The scheme name is case-insensitive, as
 * HTTP defines it.
 */
export function presentedCredential(headerValue: string | null, scheme: RouteProtection['scheme']): string | undefined {
  if (headerValue === null) {
    return undefined
  }
  if (scheme === undefined) {
    return headerValue
  }
  const match = /^([^\s]+)\s+(.+)$/.exec(headerValue.trim())
  if (!match || match[1].toLowerCase() !== scheme.toLowerCase()) {
    return undefined
  }
  return match[2]
}

/** What a caller sends, as the inspector and the docs show it. */
export function headerExample(protection: ProtectionHeader): string {
  return `${protection.header}: ${protection.scheme ? `${protection.scheme} ` : ''}<value>`
}
