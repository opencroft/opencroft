import type { McpServerConfig } from 'agent-client/mcp-types'
import type { AgentSelection } from 'agent-client/types'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { getSetting, upsertSetting } from '@/server/data'

// Global MCP server list for local agents, stored in the settings table (the
// data volume) rather than an on-disk mcp-config.json file.
const SETTING_ID = 'agent-mcp-servers'

export async function readMcpServers(): Promise<McpServerConfig[]> {
  const row = await getSetting(SETTING_ID)
  if (!row) {
    return []
  }
  const parsed = JSON.parse(row.data) as { servers?: McpServerConfig[] }
  return parsed.servers ?? []
}

export async function writeMcpServers(servers: McpServerConfig[]): Promise<void> {
  await upsertSetting(SETTING_ID, JSON.stringify({ servers }))
}

interface McpConnectionNodeShape {
  type?: string
  data?: {
    name?: string
    transport?: McpServerConfig['transport']
    command?: string
    args?: string[]
    url?: string
    headers?: McpServerConfig['headers']
    env?: McpServerConfig['env']
  }
}

// Every MCP Connection graph node, across every space, as an McpServerConfig.
// The node type has no structural owner field — see readMcpServersForAgent.
async function allConnectionNodeConfigs(): Promise<McpServerConfig[]> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const out: McpServerConfig[] = []
  for (const summary of registry.list()) {
    const space = registry.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    for (const node of space.graph.nodes as McpConnectionNodeShape[]) {
      if (node.type !== 'mcp-connection' || !node.data?.name) {
        continue
      }
      out.push({
        name: node.data.name,
        transport: node.data.transport ?? 'http',
        url: node.data.url,
        command: node.data.command,
        args: node.data.args,
        headers: node.data.headers,
        env: node.data.env,
      })
    }
  }
  return out
}

// An MCP Connection node's own name is the only ownership signal that exists
// today (the node type carries no owner field) — by convention it's already
// always `<service>-mcp-<identity>`, e.g. `openproject-mcp-carol`. Matching
// against it, rather than adding a schema field, keeps this entirely inside
// reviewable app code instead of a live, unversioned local-extension edit.
function ownsConnectionName(name: string, mcpIdentity: string): boolean {
  return name === `mcp-${mcpIdentity}` || name.endsWith(`-mcp-${mcpIdentity}`)
}

// The global list, plus — when the caller carries an mcpIdentity — that
// caller's own MCP Connection node(s), surfaced the same way a global entry
// would be. A caller's own connection needs no entry in the global list at
// all once this runs: it's reachable automatically, which is what removes
// the reason to ever add one there for personal access.
export async function readMcpServersForAgent(selection: AgentSelection): Promise<McpServerConfig[]> {
  const global = await readMcpServers()
  const mcpIdentity = selection.mcpIdentity
  if (!mcpIdentity) {
    return global
  }
  const owned = (await allConnectionNodeConfigs()).filter((server) => ownsConnectionName(server.name, mcpIdentity))
  if (owned.length === 0) {
    return global
  }
  const ownedNames = new Set(owned.map((server) => server.name))
  return [...owned, ...global.filter((server) => !ownedNames.has(server.name))]
}

// A name already claimed by an MCP Connection node has its own reachable path
// (readMcpServersForAgent, once the caller's identity matches its naming
// convention) — registering it globally too is the exact drift this guards
// against: it re-teaches the next agent that mcp_set is how you restore
// access to your own connection.
export async function isConnectionNodeName(name: string): Promise<boolean> {
  const configs = await allConnectionNodeConfigs()
  return configs.some((server) => server.name === name)
}
