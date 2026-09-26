import type { PermissionContext, PermissionOutcome } from 'agent-client/agent-client'

import { isReadOnlyToolCall } from '@/app/_authed/(mcp)/_server/tools'

// Which tool calls the agent chat lets through without asking, and on whose
// word. The global approval modes (YOLO, auto-approve) are applied by the
// caller — see agent-client-instance.ts; what lives here is the per-tool
// question, so it can be read and tested as one.

// ACP tool-call kinds that only read state. Used where this app has nothing to
// say about the tool, which means the classification came from whoever built the
// tool call: an agent sees a name, a description and a schema, and none of those
// report whether a call writes. So it is a hint, and it is consulted last.
const READONLY_KINDS = new Set(['read', 'search', 'fetch', 'think'])

/**
 * Whether one tool call is auto-allowed, prompted for, or refused.
 *
 * For this app's own tools the answer comes from `isReadOnlyToolCall` — the
 * classification this app maintains (`READ_ONLY_TOOLS`, the same one that
 * reaches an agent as the MCP `readOnlyHint` annotation, and for `app_call` the
 * action it names, resolved on this server from the call's input). That is the half the hint cannot cover: an
 * annotation only works if the harness on the other side reads it, which differs
 * per harness and is nobody's to promise here, while this runs on every request.
 *
 * So a declared read-only tool is allowed, an undeclared one prompts, and the
 * kind the request arrived with is not consulted at all for a tool this app
 * classifies — it cannot overrule the declaration in either direction.
 *
 * Anything else — another MCP server's tool, a harness's own built-in — has no
 * declaration here, and the kind is the only thing left to go on.
 */
export async function toolPermissionOutcome({
  localToolName,
  toolKind,
  toolInput,
}: PermissionContext): Promise<PermissionOutcome> {
  if (localToolName !== undefined) {
    return (await isReadOnlyToolCall(localToolName, toolInput)) ? 'allow' : 'prompt'
  }
  return toolKind && READONLY_KINDS.has(toolKind) ? 'allow' : 'prompt'
}
