/**
 * MCP tool definitions and handlers for the App Dashboard.
 *
 * Graph tools are scoped by `space` (slug).
 * If omitted, the active space is used. Extension tools operate on v2
 * local extensions (folders under `data/extensions/local/<slug>/`). Source files are read and
 * edited via the remote_* tools (remote_read/remote_write/remote_edit/remote_exec/remote_script)
 * against the static handle "extensions/<slug>" — see `resolveLocalExtensionContext` — rather
 * than a dedicated per-file extension tool.
 * UI feedback (toasts, focus, comments) is broadcast via SSE.
 */

import { ApprovalRejectedError, awaitApproval, getApprovalMeta } from '@/app/_authed/(approvals)/_server/with-approval'
import { dispatchExecutionContext, NoExecTargetError } from '@/app/_authed/(extension-runtime)/_server/exec-dispatch'
import { definitions as actionDefinitions, handlers as actionHandlers } from '@/app/_authed/(mcp)/_server/action-tools'
import { definitions as appDefinitions, handlers as appHandlers } from '@/app/_authed/(mcp)/_server/app-tools'
import { recordAudit } from '@/app/_authed/(mcp)/_server/audit'
import { definitions as chatDefinitions, handlers as chatHandlers } from '@/app/_authed/(mcp)/_server/chat-tools'
import { DbReadRefused, runBoundedRead } from '@/app/_authed/(mcp)/_server/db-read'
import { type ListedTool, presentTool } from '@/app/_authed/(mcp)/_server/execution-mode'
import {
  definitions as extensionManagementDefinitions,
  handlers as extensionManagementHandlers,
} from '@/app/_authed/(mcp)/_server/extension-management-tools'
import { executeExtensionTool, getExtensionToolDefinitions } from '@/app/_authed/(mcp)/_server/extension-tools'
import {
  definitions as mcpServerDefinitions,
  handlers as mcpServerHandlers,
} from '@/app/_authed/(mcp)/_server/mcp-server-tools'
import { definitions as nodeDefinitions, handlers as nodeHandlers } from '@/app/_authed/(mcp)/_server/node-tools'
import { definitions as remoteDefinitions, handlers as remoteHandlers } from '@/app/_authed/(mcp)/_server/remote-tools'
import { skillToolDefinitions, skillToolHandlers } from '@/app/_authed/(mcp)/_server/skill-tools'
import { definitions as spaceDefinitions, handlers as spaceHandlers } from '@/app/_authed/(mcp)/_server/space-tools'
import { definitions as taskDefinitions, handlers as taskHandlers } from '@/app/_authed/(mcp)/_server/task-tools'
import type { ToolCallerContext, ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, type GraphNode, resolveSpace, textResult } from '@/app/_authed/(mcp)/_server/tool-shared'
import {
  askUserDefinitions,
  sendToastDefinitions,
  handlers as userHandlers,
} from '@/app/_authed/(mcp)/_server/user-tools'
import { isYoloMode } from '@/app/_authed/(mcp)/_server/yolo'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// The families moved into their own modules; these names were part of this
// module's surface before the split and stay reachable from it.
export { localSlugFromExtensionId } from '@/app/_authed/(mcp)/_server/extension-management-tools'
export {
  buildAtomicReplaceCommand,
  buildBase64WriteCommands,
  buildCountedReadCommand,
  buildLocalExtensionCtx,
  buildResolveTargetCommand,
  buildScratchInitCommand,
  buildTempWritePath,
  capColumns,
  extensionSlugFromTarget,
  globPatternToEre,
  insideExcludedDir,
  parseCountedRead,
  parseResolveTarget,
  type RemoteWriteTarget,
  remoteExec,
  remoteExecDetailed,
  renderReadResult,
  resolveRemoteFilePath,
  resolveTerminalContext,
  SEARCH_EXCLUDED_DIRS,
  shellQuote,
  withTruncationNote,
  writeFileExactWith,
} from '@/app/_authed/(mcp)/_server/remote-tools'
export { isValidLocalExtensionSlug, replaceExact, requireCallingAgent } from '@/app/_authed/(mcp)/_server/tool-shared'

/**
 * The tools that cannot change anything, declared rather than guessed.
 *
 * WHY A LIST HERE AND NOT A FLAG ON EACH DEFINITION. This is a security
 * classification, and its value is that it can be reviewed as a whole: every
 * admission is visible in one screen, next to the rule it was admitted under,
 * and adding a name is a diff a reviewer cannot miss. Seventeen flags spread
 * through nine hundred lines of definitions are the same information and a
 * worse review surface. It sits beside `toolDefinitions` because that is the
 * source it describes, and the test below keeps the two from drifting.
 *
 * THE ADMISSION CRITERION, and what a review checks each entry against. A tool
 * belongs here only if BOTH hold:
 *   (a) it cannot mutate state by construction, and
 *   (b) its output cannot page a credential store wholesale.
 *
 * READ (a) STRICTLY, because three entries here only just satisfy it. The
 * remote reads do not read a file through an API that cannot write -- they
 * COMPOSE A SHELL COMMAND. What makes them non-mutating is a conjunction that
 * a future edit can break silently: no verb in the command writes, and every
 * value interpolated into it is quoted. Neither half is enforced by anything;
 * both are properties of the handlers as they stand.
 *
 * THAT NOW MATTERS TWICE OVER. Before this set existed those three prompted,
 * so an unquoted interpolation added later would have been shown to somebody
 * before it ran. They are auto-allowed now, and nobody will be asked. A change
 * to how any of them builds its argv is therefore a change to this
 * classification, whether or not the person making it opens this file.
 *
 * A tool NOT listed is undeclared, which is not the same as "mutating". It
 * keeps whatever gate it already had, so forgetting a tool costs friction and
 * never safety -- the direction this has to fail in.
 *
 * Deliberately absent, and each for a stated reason rather than an oversight:
 *
 *   db_read          -- fails (b). Its deny-list is derived from the auth
 *                       schema alone, so the secrets table and the graph are
 *                       both readable, and the graph holds credentials as
 *                       plain values. Gated until that is closed, then
 *                       re-evaluated -- including whether the settings table
 *                       has to join the deny-list.
 *   send_toast,      -- broadcast-only, so they persist nothing, but they act
 *   focus_node,         on other people's screens. They fail (a) in the sense
 *   comment_nodes,      that matters: a caller has an effect somebody else
 *   uncomment_nodes     sees.
 *   mcp_test         -- composes an arbitrary outbound request, headers
 *                       included.
 *   ask_user         -- interrupts a person.
 *
 * The three remote reads ARE here despite reading files this process cannot
 * vet: their risk is disclosure rather than mutation, and a prompt does not
 * defend against disclosure once it is the fortieth of the hour. What defends
 * values is not storing them where a read finds them.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Graph and space reads: return stored structure, write nothing.
  'list_spaces',
  'list_nodes',
  'find_nodes',
  'get_nodes',
  'list_edges',
  'list_actions',
  'app_list',
  'app_get',
  'app_actions',
  'app_find',
  // Extension and registry reads: manifests and listings, no install path.
  'list_extensions',
  'get_extension',
  'registry_list',
  // Group-chat reads: the caller's own memberships, a thread's turns, a
  // compaction's progress. All scoped to the calling agent already.
  'group_chat_list',
  'group_chat_turns',
  'group_chat_compact_status',
  'artifact_list',
  // Configuration read. Secret values are redacted by the handler itself, so
  // this returns names and shapes rather than credentials.
  'mcp_list',
  // Remote filesystem reads. See the note above on why these are admitted.
  'remote_read',
  'remote_glob',
  'remote_grep',
  // Background-task read: a task's record — its state, timing and an output
  // tail the service bounds. Its risk is the remote reads' one, disclosure of
  // what a command printed; stopping a task is task_cancel, which is gated.
  'task_status',
])

/**
 * Every static tool, as both surfaces list it: the HTTP route's `tools/list`
 * and the in-process bridge read this one array, so presenting a tool's
 * execution mode here is what keeps the two from describing it differently.
 */
export const toolDefinitions: ListedTool[] = [
  ...sendToastDefinitions,
  ...chatDefinitions,

  {
    name: 'db_read',
    description:
      "Run one read-only SQL statement against this instance's database and return the rows. For establishing what a migration or a backfill actually did, rather than inferring it from the fact that the app booted. Read-only is enforced by the transaction, not by inspecting the statement, so a write is refused wherever it would be performed. The tables holding credentials and session tokens are refused — which relations a statement reads is answered by the query planner, so a view or an alias does not get past it. Email addresses are removed from the values by their shape, and `redactions` counts what was removed. Results are capped and a truncated result says so: never read `truncated: false` or `redactions: 0` off a result you did not check. An agent's own account rows live in `user`, which is readable; the graph (spaces, nodes, agents) is NOT in the database — use find_nodes/get_nodes for those.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        sql: {
          type: 'string',
          description:
            'One SELECT-shaped statement, and exactly one: a second is refused here rather than left to the driver, so that what the planner is asked about is what runs. A semicolon inside a literal, an identifier or a comment is not a second statement.',
        },
        maxRows: { type: 'number', description: 'Row cap (default 200, max 2000). Exceeding it sets `truncated`.' },
      },
      required: ['sql'],
    },
  },

  ...spaceDefinitions,
  ...nodeDefinitions,
  ...extensionManagementDefinitions,
  ...remoteDefinitions,
  ...actionDefinitions,
  ...appDefinitions,
  ...taskDefinitions,
  ...mcpServerDefinitions,

  // ── Skills ───────────────────────────────────────────────────────────────
  ...skillToolDefinitions,

  ...askUserDefinitions,
].map(presentTool)

// ── Agent Tool: dynamic graph-defined tools ───────────────────────────

interface AgentToolNodeData {
  name: string
  description: string
  inputSchema: string
  requireApproval: boolean
}

export async function getAgentToolDefinitions(extraReservedNames: Set<string> = new Set()) {
  const defs: { name: string; description: string; inputSchema: Record<string, unknown> }[] = []

  // Collect all existing static tool names (plus any caller-supplied reserved
  // names, e.g. extension-contributed tools) to avoid collisions
  const staticNames = new Set([...toolDefinitions.map((t) => t.name), ...extraReservedNames])

  try {
    const registry = getSpacesRegistry()
    await registry.ensureLoaded()

    for (const space of registry.list()) {
      const runtime = registry.getBySlug(space.slug)
      if (!runtime) {
        continue
      }

      const nodes = [...runtime.graphs.values()].flatMap((g) => g.graph.nodes) as unknown as GraphNode[]
      for (const node of nodes) {
        if (node.type !== 'agent-tool') {
          continue
        }

        const d = (node.data ?? {}) as unknown as AgentToolNodeData
        const toolName = d.name?.trim()
        if (!toolName) {
          continue
        }

        if (staticNames.has(toolName)) {
          continue
        } // static tools win
        if (defs.some((x) => x.name === toolName)) {
          continue
        } // first space wins

        let inputSchema: Record<string, unknown> = { type: 'object', properties: {} }
        try {
          inputSchema = JSON.parse(d.inputSchema || '{}')
        } catch {
          // skip invalid JSON schema
        }

        defs.push({
          name: toolName,
          description: d.description || `Agent tool: ${toolName}`,
          inputSchema: {
            type: 'object' as const,
            properties: {
              ...((inputSchema.properties as Record<string, unknown>) ?? {}),
            },
          },
        })
      }
    }
  } catch {
    // If spaces can't load, just return empty
  }

  return defs
}

/**
 * Execute an agent-tool node's connected handler script.
 * Returns the handler result or throws on error.
 */
interface AgentToolExecResult {
  result: Record<string, unknown>
  requiredApproval: boolean
}

export interface ToolCallOptions {
  signal?: AbortSignal
  /** Call made by the internal agent: skip the MCP approval queue (the agent chat has its own permission flow). */
  internal?: boolean
  /**
   * The agent name behind the caller, when the surface resolved one: the HTTP
   * surface from the request's credential, the in-process bridge from the
   * session's own bookkeeping. Absent from any surface that can assert
   * neither, and tools that need it refuse rather than guess — see
   * `ToolCallerContext`.
   */
  callerAgent?: string | null
  /**
   * The calling session's id. Only the in-process bridge can assert one, from
   * the session's own bookkeeping; the HTTP surface has no session and passes
   * none. See `ToolCallerContext`.
   */
  callerSessionId?: string
}

export async function executeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: ToolCallOptions = {},
): Promise<AgentToolExecResult> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()

  // Find the agent-tool node across all spaces
  for (const space of registry.list()) {
    const runtime = registry.getBySlug(space.slug)
    if (!runtime) {
      continue
    }

    const nodes = [...runtime.graphs.values()].flatMap((g) => g.graph.nodes) as unknown as GraphNode[]

    const toolNode = nodes.find(
      (n) => n.type === 'agent-tool' && ((n.data ?? {}) as Record<string, unknown>).name === toolName,
    )
    if (!toolNode) {
      continue
    }

    // Check requireApproval
    const d = (toolNode.data ?? {}) as unknown as AgentToolNodeData
    const requiredApproval = d.requireApproval && !isYoloMode() && !opts.internal
    if (requiredApproval) {
      await awaitApproval({ tool: toolName, args, view: 'default', signal: opts.signal, spaceId: space.slug })
    }

    // Build event for the handler, then dispatch through the shared
    // execution-context dispatcher (handles both extension `handle` actions
    // and built-in script-node handlers — see exec-dispatch.ts).
    const event = { params: args, context: { toolName: toolName } }

    try {
      const { primary } = await dispatchExecutionContext({
        sourceNodeId: toolNode.id,
        sourceHandleId: 'exec-out',
        event,
      })

      if (primary.error) {
        return { result: textResult(`Agent tool "${toolName}" error: ${primary.error}`), requiredApproval }
      }
      if (typeof primary.body === 'object' && primary.body !== null) {
        return { result: textResult(JSON.stringify(primary.body)), requiredApproval }
      }
      return { result: textResult(String(primary.body ?? '')), requiredApproval }
    } catch (err) {
      if (err instanceof NoExecTargetError) {
        return {
          result: textResult(`Agent tool "${toolName}" has no connected handler script.`),
          requiredApproval: false,
        }
      }
      return {
        result: textResult(`Agent tool "${toolName}" error: ${err instanceof Error ? err.message : String(err)}`),
        requiredApproval,
      }
    }
  }

  throw { code: -32601, message: `Agent tool not found: ${toolName}` }
}

// ── Tool handler registry ──────────────────────────────────────────────

// The handler contract and the caller context both live in tool-caller.ts —
// see the note there for why they are not declared here.

const handlers: Record<string, ToolHandler> = {
  ...userHandlers,
  ...chatHandlers,

  // ── db_read ─────────────────────────────────────────────────────
  db_read: async (args) => {
    const statement = typeof args.sql === 'string' ? args.sql.trim() : ''
    if (!statement) {
      fail(-32602, 'Missing required param: sql')
    }
    // Imported here rather than at module scope: `@opencroft/db` opens the
    // database as a top-level await, and this module is loaded by paths that
    // have no business starting it.
    const { db } = await import('@opencroft/db')
    const { sql: raw } = await import('drizzle-orm')
    try {
      const result = await db.transaction(async (tx) =>
        runBoundedRead(
          {
            execute: async (text: string) => {
              const r = await tx.execute(raw.raw(text))
              return { rows: (r.rows ?? []) as Record<string, unknown>[] }
            },
          },
          { sql: statement, maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined },
        ),
      )
      return textResult(JSON.stringify(result, null, 2))
    } catch (err) {
      if (err instanceof DbReadRefused) {
        fail(-32602, err.message)
      }
      throw err
    }
  },

  ...spaceHandlers,
  ...nodeHandlers,
  ...extensionManagementHandlers,
  ...remoteHandlers,
  ...actionHandlers,
  ...appHandlers,
  ...taskHandlers,
  ...mcpServerHandlers,

  // ── Skills ──────────────────────────────────────────────────────────────
  ...skillToolHandlers,
}

/**
 * Whether this tool queues for approval on the external MCP surface.
 *
 * Exported so the OTHER classification can be checked against it. `withApprovalRequired`
 * is a policy about a surface; `READ_ONLY_TOOLS` is a property of a tool. They
 * are allowed to differ — that is the point of them being two things — but a
 * tool in both is incoherent, and without a way to ask this question the
 * contradiction lives in two files and is visible from neither.
 */
export function isApprovalGated(toolName: string): boolean {
  const handler = handlers[toolName]
  return handler !== undefined && getApprovalMeta(handler) !== undefined
}

function rejectionResult(reason: string): Record<string, unknown> {
  const text = reason
    ? `The tool use was rejected. The user provided the following reason for the rejection: ${reason}`
    : 'The tool use was rejected by the user.'
  return { content: [{ type: 'text' as const, text }], isError: true }
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  opts: ToolCallOptions = {},
): Promise<Record<string, unknown>> {
  const start = Date.now()
  const handler = handlers[name]
  if (!handler) {
    const staticNames = new Set(toolDefinitions.map((t) => t.name))
    const extensionDef = (await getExtensionToolDefinitions(staticNames)).find((t) => t.name === name)
    if (extensionDef) {
      const approvalRequired = extensionDef.requireApproval && !isYoloMode() && !opts.internal
      try {
        if (approvalRequired) {
          const spaceId = typeof args.space === 'string' ? await resolveSpace(args) : undefined
          await awaitApproval({ tool: name, args, signal: opts.signal, spaceId })
        }
        const result = await executeExtensionTool(extensionDef.extensionId, name, args)
        await recordAudit({
          tool: name,
          args,
          result,
          status: approvalRequired ? 'approved' : 'auto-approved',
          durationMs: Date.now() - start,
        })
        return result
      } catch (e) {
        if (e instanceof ApprovalRejectedError) {
          await recordAudit({
            tool: name,
            args,
            error: e.reason || '(no reason)',
            status: 'rejected',
            durationMs: Date.now() - start,
          })
          return rejectionResult(e.reason)
        }
        const err = e as { message?: string }
        await recordAudit({
          tool: name,
          args,
          error: err.message ?? String(e),
          status: 'error',
          durationMs: Date.now() - start,
        })
        throw e
      }
    }

    // Fall back to graph-defined agent tools
    const execResult = await executeAgentTool(name, args, opts)
    await recordAudit({
      tool: name,
      args,
      result: execResult.result as Record<string, unknown>,
      status: execResult.requiredApproval ? 'approved' : 'auto-approved',
      durationMs: Date.now() - start,
    })
    return execResult.result as Record<string, unknown>
  }
  const meta = getApprovalMeta(handler)
  const approvalRequired = Boolean(meta) && !isYoloMode() && !opts.internal
  try {
    if (approvalRequired) {
      const spaceId = typeof args.space === 'string' ? await resolveSpace(args) : undefined
      await awaitApproval({ tool: name, args, view: meta?.view, signal: opts.signal, spaceId })
    }
    const caller: ToolCallerContext = { agent: opts.callerAgent ?? null }
    if (opts.callerSessionId) {
      caller.sessionId = opts.callerSessionId
    }
    const result = await handler(args, caller)
    await recordAudit({
      tool: name,
      args,
      result,
      status: approvalRequired ? 'approved' : 'auto-approved',
      durationMs: Date.now() - start,
    })
    return result
  } catch (e) {
    if (e instanceof ApprovalRejectedError) {
      await recordAudit({
        tool: name,
        args,
        error: e.reason || '(no reason)',
        status: 'rejected',
        durationMs: Date.now() - start,
      })
      return rejectionResult(e.reason)
    }
    const err = e as { message?: string }
    await recordAudit({
      tool: name,
      args,
      error: err.message ?? String(e),
      status: 'error',
      durationMs: Date.now() - start,
    })
    throw e
  }
}
