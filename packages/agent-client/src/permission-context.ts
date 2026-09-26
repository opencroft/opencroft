import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

import { localToolRef } from './local-tool-ref'

// The host-facing side of a permission request: what a host is told about one
// tool call, and what it may answer. Kept apart from the engine so the reading
// of a request can be exercised on its own — a field read from the wrong place
// here disables a host's whole policy while leaving every other symptom intact.

// What the host decides to do with an ACP permission request:
//  - 'allow':  resolve it as approved without prompting the user.
//  - 'deny':   resolve it as rejected without prompting the user.
//  - 'prompt': surface it to the chat UI for the user to decide (the default).
export type PermissionOutcome = 'allow' | 'deny' | 'prompt'

export interface PermissionContext {
  sessionId: string
  // The ACP tool-call title (best-effort tool name).
  toolName: string
  // The host-registered name of the tool, when the request is for one of the
  // host's OWN local tools — the ones it passed in as `tools`. This is an
  // identity: it is read off the reference the request carries, anchored on the
  // built-in MCP server's own name, and absent unless that matches (see
  // localToolRef). A host can look this up in the registry it built the tools
  // from and answer from its own declarations instead of inferring anything.
  //
  // Undefined for every other tool call — another MCP server's tool, a
  // harness's own built-in — where the host has no declaration to offer and
  // `toolKind` is all there is.
  localToolName?: string
  // The ACP tool-call kind (e.g. 'read' | 'edit' | 'execute'), when the agent
  // provides one — lets the host auto-approve read-only kinds, etc.
  //
  // Whoever sends it classified the tool from its name, description and schema,
  // which do not say whether a call writes. So it is a hint from outside, and a
  // host that has its own answer for this tool should prefer that answer.
  toolKind?: string
  // The arguments the call was made with (ACP `rawInput`), when the request
  // carries them. For a tool whose effect depends on what it is asked to do —
  // one tool dispatching to many operations — the name alone cannot say
  // whether the call writes; the host reads the operation from here. Untrusted
  // input: a host classifies from it, never grants on its mere presence.
  toolInput?: unknown
}

export type PermissionHandler = (context: PermissionContext) => PermissionOutcome | Promise<PermissionOutcome>

/**
 * Read one permission request into the facts a host decides on.
 *
 * `name` is the protocol's field for what the tool IS and `title` is what to
 * show a person, so `name` is the one to prefer — but it is marked experimental
 * in the protocol and an agent need not send it, and the title has been seen
 * carrying the reference instead. So both are offered to the same anchored read,
 * and a reference that is not this host's own resolves to nothing rather than to
 * a near match.
 */
export function permissionContext(request: RequestPermissionRequest, mcpServerName: string): PermissionContext {
  const title = request.toolCall.title ?? ''
  return {
    sessionId: request.sessionId,
    toolName: title,
    localToolName: localToolRef(request.toolCall.name, mcpServerName) ?? localToolRef(title, mcpServerName),
    toolKind: request.toolCall.kind ?? undefined,
    toolInput: request.toolCall.rawInput ?? undefined,
  }
}
