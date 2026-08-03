import { jsonSchemaToZodShape } from 'agent-client/json-schema'
import type { LocalTool } from 'agent-client/mcp-server'

import { getExtensionToolDefinitions } from '@/app/_authed/(mcp)/_server/extension-tools'
import { getAgentToolDefinitions, handleToolCall, toolDefinitions } from '@/app/_authed/(mcp)/_server/tools'

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
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await handleToolCall(name, args, { internal: true })
  } catch (e) {
    const err = e as { message?: string }
    return { content: [{ type: 'text' as const, text: err.message ?? String(e) }], isError: true }
  }
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

function toLocalTool(def: ToolDef): LocalTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: jsonSchemaToZodShape(def.inputSchema),
    handler: (args) => callTool(def.name, args),
  }
}

// The static registry never changes at runtime, so its schemas only need
// converting once — but lazily, on first actual use, not at module-load time:
// tools.ts imports agentClient (agent-client-instance.ts) for
// refreshMcpServers(), and agent-client-instance.ts imports this module for
// `tools`, so tools.ts <-> this module is a real circular import. Reading
// `toolDefinitions` at this module's top level would run before tools.ts has
// finished evaluating in that cycle and see it as undefined.
let staticTools: LocalTool[] | undefined

function getStaticTools(): LocalTool[] {
  if (!staticTools) {
    staticTools = toolDefinitions.map(toLocalTool)
  }
  return staticTools
}

// Extension-contributed tools and dynamic agent-tool graph nodes are re-read
// on every call (see getExtensionToolDefinitions()/getAgentToolDefinitions())
// so a tool installed, edited, or created on the canvas appears without an
// app restart.
export async function opencroftLocalTools(): Promise<LocalTool[]> {
  const staticNames = new Set(toolDefinitions.map((t) => t.name))
  const extensionDefs = await getExtensionToolDefinitions(staticNames)
  const dynamicDefs = await getAgentToolDefinitions(new Set(extensionDefs.map((t) => t.name)))
  return [...getStaticTools(), ...extensionDefs.map(toLocalTool), ...dynamicDefs.map(toLocalTool)]
}
