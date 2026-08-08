import { jsonSchemaToZodShape } from 'agent-client/json-schema'
import type { LocalTool, ToolsCaller } from 'agent-client/mcp-server'

import { getExtensionToolDefinitions } from '@/app/_authed/(mcp)/_server/extension-tools'
import { getAgentToolDefinitions, handleToolCall, toolDefinitions } from '@/app/_authed/(mcp)/_server/tools'
import { slug } from '@/app/_authed/(server)/_server/types'
import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'

// Bridges opencroft's own MCP tool registry (spaces, nodes, extensions, docs,
// remote ops, MCP config, skills, dynamic agent-tool graph nodes — see
// (mcp)/_server/tools.ts) directly in-process into agent-client's LocalTool
// contract. agent-client then exposes these tools over the built-in 'local'
// MCP server (ACP harness path) and directly in the native harness's toolset —
// no network hop back into this app's own /api/mcp route for the agent's own
// tool calls, which used to need a container-URL rewrite to even be reachable.
//
// `internal: true` mirrors the `x-opencroft-internal` header the old HTTP
// bridge sent: these calls skip the external MCP approval queue because the
// agent chat already gates tool calls through its own permission flow (ACP
// requestPermission / the native harness's tool gate).
async function callTool(
  name: string,
  args: Record<string, unknown>,
  callerAgent: string | null,
): Promise<Record<string, unknown>> {
  try {
    return await handleToolCall(name, args, { internal: true, callerAgent })
  } catch (e) {
    const err = e as { message?: string }
    return { content: [{ type: 'text' as const, text: err.message ?? String(e) }], isError: true }
  }
}

/**
 * Which agent this bridge is serving, asserted from the session's own
 * bookkeeping: agent-client hands over the `mcpIdentity` it was given when the
 * session was opened — the agent node's name slug — and that is turned back
 * into the agent's name here. Nothing the caller passes in a tool argument
 * takes part, and `internal: true` grants no identity of its own: a call that
 * skips the approval queue is not thereby a call from somebody.
 *
 * Null whenever the answer is not exactly one agent — no identity on the
 * session, no node whose name slugifies to it, or more than one. Tools that act
 * AS the caller refuse on null (see `requireCallingAgent`), which is the only
 * safe reading: an ambiguous identity used anyway is a message delivered as the
 * wrong agent.
 */
async function callingAgentName(caller: ToolsCaller): Promise<string | null> {
  const identity = caller.mcpIdentity
  if (!identity) {
    return null
  }
  const matches = (await listAgentNodesImpl()).filter((node) => slug(node.name) === identity)
  return matches.length === 1 ? (matches[0]?.name ?? null) : null
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// The JSON-Schema-to-Zod conversion is the expensive half and does not depend
// on who is calling, so it is cached; the LocalTool wrapper around it is not,
// because its handler closes over the caller and a cached one would carry the
// previous caller's identity into the next session's tool call.
interface ConvertedTool {
  name: string
  description: string
  inputSchema: LocalTool['inputSchema']
}

function convert(def: ToolDef): ConvertedTool {
  return { name: def.name, description: def.description, inputSchema: jsonSchemaToZodShape(def.inputSchema) }
}

function toLocalTool(tool: ConvertedTool, callerAgent: string | null): LocalTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: (args) => callTool(tool.name, args, callerAgent),
  }
}

// The static registry never changes at runtime, so its schemas only need
// converting once — but lazily, on first actual use, not at module-load time:
// tools.ts imports agentClient (agent-client-instance.ts) for
// refreshMcpServers(), and agent-client-instance.ts imports this module for
// `tools`, so tools.ts <-> this module is a real circular import. Reading
// `toolDefinitions` at this module's top level would run before tools.ts has
// finished evaluating in that cycle and see it as undefined.
let staticTools: ConvertedTool[] | undefined

function getStaticTools(): ConvertedTool[] {
  if (!staticTools) {
    staticTools = toolDefinitions.map(convert)
  }
  return staticTools
}

// Extension-contributed tools and dynamic agent-tool graph nodes are re-read
// on every call (see getExtensionToolDefinitions()/getAgentToolDefinitions())
// so a tool installed, edited, or created on the canvas appears without an
// app restart.
// `caller` is required rather than defaulted: a default would silently stand in
// for a call site that forgot to say who is asking, which is the one thing this
// argument exists to make explicit. Callers with nobody to name pass `{}`.
export async function opencroftLocalTools(caller: ToolsCaller): Promise<LocalTool[]> {
  const callerAgent = await callingAgentName(caller)
  const staticNames = new Set(toolDefinitions.map((t) => t.name))
  const extensionDefs = await getExtensionToolDefinitions(staticNames)
  const dynamicDefs = await getAgentToolDefinitions(new Set(extensionDefs.map((t) => t.name)))
  return [...getStaticTools(), ...extensionDefs.map(convert), ...dynamicDefs.map(convert)].map((tool) =>
    toLocalTool(tool, callerAgent),
  )
}
