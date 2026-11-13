import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

import { localToolRef, type McpToolNaming } from './local-tool-ref'

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

/** What the harness said about a tool call when it announced it, before asking. */
export interface AnnouncedToolCall {
  title?: string
  name?: string
}

/**
 * Read one permission request into the facts a host decides on.
 *
 * `name` is the protocol's field for what the tool IS and `title` is what to
 * show a person, so `name` is the one to prefer — but it is marked experimental
 * in the protocol and an agent need not send it, and the title has been seen
 * carrying the reference instead. So both are offered to the same anchored read,
 * and a reference that is not this host's own resolves to nothing rather than to
 * a near match.
 *
 * The request is an update to a call the harness may already have announced,
 * and `announced` is that call as it was announced. Its references are read
 * after the request's own, for a harness whose request names only the bare
 * tool (the Copilot CLI), while the announced call says which server it is on.
 * `naming` is how the harness spells those references.
 */
export function permissionContext(
  request: RequestPermissionRequest,
  mcpServerName: string,
  { announced, naming }: { announced?: AnnouncedToolCall; naming?: McpToolNaming } = {},
): PermissionContext {
  const title = request.toolCall.title ?? ''
  return {
    sessionId: request.sessionId,
    toolName: title,
    localToolName:
      naming === 'server-dash-tool'
        ? announcedBareTool(title, mcpServerName, announced)
        : firstLocalToolRef([request.toolCall.name, title, announced?.name, announced?.title], mcpServerName),
    toolKind: request.toolCall.kind ?? undefined,
    toolInput: request.toolCall.rawInput ?? undefined,
  }
}

function firstLocalToolRef(
  references: (string | null | undefined)[],
  mcpServerName: string,
  naming?: McpToolNaming,
): string | undefined {
  return references
    .map((reference) => localToolRef(reference, mcpServerName, naming))
    .find((name) => name !== undefined)
}

// `<server>-<tool>` has no reserved separator, and a title is free text: a
// shell command or an edit can carry a title that reads as one of ours. So the
// request's own title is never read as a reference. The request names the bare
// tool, and the announced call is believed only when the tool it names on our
// server is that same bare tool.
function announcedBareTool(
  bareTool: string,
  mcpServerName: string,
  announced: AnnouncedToolCall | undefined,
): string | undefined {
  const name = firstLocalToolRef([announced?.name, announced?.title], mcpServerName, 'server-dash-tool')
  return name === bareTool ? name : undefined
}
