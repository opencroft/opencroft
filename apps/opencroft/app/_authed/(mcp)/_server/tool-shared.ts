/**
 * Helpers shared by more than one tool-family module: the space parameter every
 * space-addressed tool takes, the result and refusal shapes, the calling agent,
 * space and endpoint resolution, and the local-extension identity a write claim
 * is taken on.
 */

import {
  claimExtensionLock,
  extensionLockRefusalMessage,
} from '@/app/_authed/(extension-runtime)/_server/extension-lock'
import type { ToolCallerContext } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail } from '@/app/_authed/(mcp)/_server/tool-refusal'
// MCP tool calls carry no session cookie by design (a bearer-token surface),
// so every space operation reached from here must be the
// plain `*Impl`, never the createServerFn wrapper in actions.ts. The wrappers
// check the session; calling one in-process from a tool throws "Not signed
// in" for a caller that was never supposed to have a session. That is exactly
// what happened when the session gate first landed in the shared
// implementations — it broke the read tools directly, and every graph-write
// tool indirectly through withGraphConflictRetry's default load/save.
import { resolveSpaceSlugImpl } from '@/app/_authed/(space)/_server/actions-impl'
import type { AgentRef } from '@/app/_authed/(space)/_server/agents-impl'
import { parseGraphAddress } from '@/app/_authed/(space)/_server/types'

// Import-free primitives, homed on their own so code reached through a tool
// without being a tool module can use them without loading this one.
export { type ParsedEndpoint, parseEndpoint } from '@/app/_authed/(mcp)/_server/endpoint'
export { replaceExact } from '@/app/_authed/(mcp)/_server/exact-replace'
export { fail }

/** The `space` a space-addressed tool takes — required wherever it is spread, since nothing is defaulted. */
export const SPACE_PARAM = {
  space: {
    type: 'string',
    description: 'The space this is for: its slug, or a graph address "<space>.<graph>" — see list_spaces for both.',
  },
}

/** Named once so a refusal's copy and the tool it points at cannot drift apart. */
export const LOCK_TOOL_NAME = 'extension_lock'

export interface GraphNode {
  id: string
  type?: string
  position?: { x: number; y: number }
  data?: Record<string, unknown>
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

// Compact on purpose: a tool result is read by a model, which pays for every
// byte and gains nothing from indentation. Measured 26.09.2026, 2-space
// indentation made a 200-row list about half as large again.
export function jsonResult(value: unknown): Record<string, unknown> {
  return textResult(JSON.stringify(value))
}

// Every space-addressed tool comes through here, so this is the one place an
// agent's slug is turned into a space -- and it asks the registry rather than
// matching slugs against a list, which is the difference between resolving an
// address and comparing two strings. A slug a rename freed still resolves, the
// same way it does for the web routes; matching by hand saw live spaces only,
// so a renamed space vanished from all agent tooling while the UI was fine.
//
// An omitted space is REFUSED, never defaulted. There is no "current space"
// on the server: any default is somebody else's choice, and a call without an
// address used to land wherever a person or a test tab last navigated.
export async function resolveSpace(args: Record<string, unknown>): Promise<string> {
  const input = args.space
  if (typeof input !== 'string' || !input) {
    fail(-32602, 'Missing required param: space — a space slug, or "<space>.<graph>" (see list_spaces)')
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

/**
 * The SPACE a call is for, when it addresses a whole space rather than one of
 * its graphs: a graph address is accepted and its graph part dropped. What
 * everything scoped to a space's screens uses — a toast, a question, an
 * approval — since a browser subscribes by the space it shows.
 */
export async function resolveSpaceSlug(args: Record<string, unknown>): Promise<string> {
  return parseGraphAddress(await resolveSpace(args)).spaceSlug
}

// The node-id sentinel used by the static per-extension terminal-context handle
// ("extensions/<extensionFolder>"), resolved by `resolveLocalExtensionContext` instead of a
// real graph node lookup. Only local folders have one: they are the editable ones.
export const LOCAL_EXTENSION_HANDLE_NODE_ID = 'extensions'

/**
 * Refuse a write into an extension folder somebody else is working in.
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
export async function claimFolderForWrite(folder: string, caller: ToolCallerContext): Promise<void> {
  if (!caller.agent) {
    return
  }
  const decision = await claimExtensionLock(folder, caller.agent)
  if (decision.outcome === 'refused') {
    fail(
      -32000,
      extensionLockRefusalMessage(folder, decision.lock, Date.now(), `call ${LOCK_TOOL_NAME} with takeover: true`),
    )
  }
}
