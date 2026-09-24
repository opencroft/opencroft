/**
 * Helpers shared by more than one tool-family module: the space parameter every
 * graph-addressed tool takes, the result and refusal shapes, the calling agent,
 * space and endpoint resolution, and the local-extension identity a write claim
 * is taken on.
 */

import { claimExtensionLease, leaseRefusalMessage } from '@/app/_authed/(extension-runtime)/_server/extension-lease'
import type { ToolCallerContext } from '@/app/_authed/(mcp)/_server/tool-caller'
// MCP tool calls carry no session cookie by design (a bearer-token surface),
// so every space operation reached from here must be the
// plain `*Impl`, never the createServerFn wrapper in actions.ts. The wrappers
// check the session; calling one in-process from a tool throws "Not signed
// in" for a caller that was never supposed to have a session. That is exactly
// what happened when the session gate first landed in the shared
// implementations — it broke the read tools directly, and every graph-write
// tool indirectly through withGraphConflictRetry's default load/save.
import { getActiveSpaceSlugImpl, resolveSpaceSlugImpl } from '@/app/_authed/(space)/_server/actions-impl'
import type { AgentRef } from '@/app/_authed/(space)/_server/agents-impl'
import { parseGraphAddress } from '@/app/_authed/(space)/_server/types'

export const SPACE_PARAM = {
  space: {
    type: 'string',
    description:
      'Graph address: a space slug (its default graph) or "<space>.<graph>" for a named graph — see list_spaces for both. Omit to target the default graph of the active space.',
  },
}

/** Named once so a refusal's copy and the tool it points at cannot drift apart. */
export const LEASE_TOOL_NAME = 'extension_lease'

export interface GraphNode {
  id: string
  type?: string
  position?: { x: number; y: number }
  data?: Record<string, unknown>
}

export interface ParsedEndpoint {
  nodeId: string
  handle?: string
}

/**
 * The agent a tool is acting as, or a refusal.
 *
 * THE WHOLE GATE RESTS ON THIS. A tool that acts on behalf of an agent needs to
 * know which one, and the only honest source is the credential the request
 * arrived with. There is deliberately no parameter for it and no fallback: an
 * agent name taken from tool arguments would let any caller name any agent, and
 * a default would silently pick one.
 *
 * So a caller the surface could not identify is refused — today that is a
 * bridged call whose session could not be attributed to exactly one agent,
 * since the HTTP endpoint refuses a request without a valid token before any
 * tool runs.
 *
 * Each surface asserts the identity from what only it can know, and neither
 * accepts one from the caller: the HTTP surface from the MCP token, which names
 * the agent's NODE, the in-process bridge from the session's own bookkeeping,
 * which names the agent. The node is returned wherever there is one, so a
 * token-identified caller is never re-resolved by a name another node might
 * share. Being internal confers nothing on its own — an unattributable bridged
 * call is refused here exactly like an unidentified HTTP one would be.
 */
export function requireCallingAgent(caller: ToolCallerContext): AgentRef {
  if (caller.agentNodeId) {
    return { nodeId: caller.agentNodeId, name: caller.agent ?? '' }
  }
  if (!caller.agent) {
    fail(
      -32603,
      'This tool acts as the calling agent, and this request did not identify one. ' +
        'It has to be called with an MCP token issued to the agent.',
    )
  }
  return caller.agent
}

export function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text' as const, text }] }
}

export function fail(code: number, message: string): never {
  throw { code, message }
}

// Every space-addressed tool comes through here, so this is the one place an
// agent's slug is turned into a space -- and it asks the registry rather than
// matching slugs against a list, which is the difference between resolving an
// address and comparing two strings. A slug a rename freed still resolves, the
// same way it does for the web routes; matching by hand saw live spaces only,
// so a renamed space vanished from all agent tooling while the UI was fine.
export async function resolveSpace(args: Record<string, unknown>): Promise<string> {
  const input = args.space as string | undefined
  if (!input) {
    return getActiveSpaceSlugImpl()
  }
  // A graph address rides on the space part: the space resolves through the
  // same alias fallback as ever, the graph suffix is carried along canonically
  // and validated where the graph is actually loaded.
  const { spaceSlug, graphSlug } = parseGraphAddress(input)
  const resolved = await resolveSpaceSlugImpl(spaceSlug)
  if (resolved) {
    return graphSlug ? `${resolved}.${graphSlug}` : resolved
  }
  fail(-32602, `Space not found: ${input} (use a slug or "<space>.<graph>" — see list_spaces)`)
}

export function parseEndpoint(raw: string): ParsedEndpoint {
  const i = raw.indexOf('/')
  if (i === -1) {
    return { nodeId: raw }
  }
  return { nodeId: raw.slice(0, i), handle: raw.slice(i + 1) }
}

// The node-id sentinel used by the static per-extension terminal-context handle
// ("extensions/<slug>"), resolved by `resolveLocalExtensionContext` below instead of a real
// graph node lookup.
export const LOCAL_EXTENSION_HANDLE_NODE_ID = 'extensions'

// Conservative allow-list for a local extension folder name: must start alphanumeric, then only
// alphanumeric/dot/underscore/hyphen. This can never contain "/", "\", or "..", but both are also
// rejected explicitly in `isValidLocalExtensionSlug` for defense in depth.
const LOCAL_EXTENSION_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * True for slugs that are safe to join onto `localExtRoot()` with no path-traversal risk. Pure
 * and side-effect free, so it's unit-testable on its own.
 */
export function isValidLocalExtensionSlug(slug: string): boolean {
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    return false
  }
  return LOCAL_EXTENSION_SLUG_RE.test(slug)
}

/**
 * Refuse a write into an extension directory somebody else is working in.
 *
 * These directories are shared: unlike a per-task checkout, every session
 * working on one extension edits the same tree, and two writers there produce
 * no conflict and no error — just a commit containing changes its author never
 * made. Claiming the directory turns that into a message at the moment it
 * happens.
 *
 * ADVISORY BY CONSTRUCTION. A caller can run an arbitrary command in that same
 * directory, so nothing at this layer can prevent a write — only surface it.
 * Two consequences are deliberate: an unidentified caller is let through rather
 * than refused (there is no honest way to name it as a holder, and refusing
 * every anonymous write would break surfaces that never had an identity), and
 * a held directory is always available to whoever explicitly takes it over.
 */
export async function claimSlugForWrite(slug: string, caller: ToolCallerContext): Promise<void> {
  if (!caller.agent) {
    return
  }
  const decision = await claimExtensionLease(slug, caller.agent)
  if (decision.outcome === 'refused') {
    fail(-32000, leaseRefusalMessage(slug, decision.lease, Date.now(), `call ${LEASE_TOOL_NAME} with takeover: true`))
  }
}

/**
 * Exact-string replacement shared by remote_edit and edit_node_property: enforces the
 * found/unique contract, and uses a function replacer so dollar-prefixed substitution patterns
 * in newString are inserted literally instead of being expanded.
 */
export function replaceExact(
  content: string,
  edit: { oldString: string; newString: string; replaceAll: boolean },
  subject: string,
): string {
  const occurrences = content.split(edit.oldString).length - 1
  if (occurrences === 0) {
    fail(-32602, `oldString not found in ${subject}`)
  }
  if (occurrences > 1 && !edit.replaceAll) {
    fail(-32602, `oldString is not unique (${occurrences} matches). Set replaceAll=true or provide more context.`)
  }
  if (edit.replaceAll) {
    return content.split(edit.oldString).join(edit.newString)
  }
  return content.replace(edit.oldString, () => edit.newString)
}
