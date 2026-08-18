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
// The node type has no structural owner field — its name is the only signal
// isConnectionNodeName below has to go on.
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

// The global list only. Previously also auto-forwarded a caller's own MCP
// Connection node(s) by naming convention (`<service>-mcp-<identity>`) into
// their session's mounted tools -- removed: that mount rode
// the session's own long-lived MCP client connection, which is exactly what
// kept rotting (session-init failures, 404 "Could not find session", -32602
// on every call) with nothing here able to heal it short of a full session
// restart. The tracker path now is the mcp-connection NODE route (`call` →
// `call_tool`, a fresh handshake every call — see the openproject-issues
// skill), never an auto-mounted toolset. `selection` is unused now but kept
// in the signature: agent-client's `loadMcpServers` hook still calls this
// with one, and changing that shape is out of scope here (agent-client is a
// subtree; this stays product-agnostic by not touching it).
export async function readMcpServersForAgent(_selection: AgentSelection): Promise<McpServerConfig[]> {
  return readMcpServers()
}

// A name already claimed by an MCP Connection node must never also be
// registered globally — that's the exact drift this check guards against:
// a personal credential becoming visible to every agent's session. Still
// enforced regardless of the auto-forward's removal above; the two are
// separate concerns (this is about where a credential is VISIBLE, not about
// how a session reaches its own connection).
export async function isConnectionNodeName(name: string): Promise<boolean> {
  const configs = await allConnectionNodeConfigs()
  return configs.some((server) => server.name === name)
}
