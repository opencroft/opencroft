import type { KeyValue, McpServerConfig } from 'agent-client/mcp-types'
import type { AgentSelection } from 'agent-client/types'

import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { secretNameOf } from '@/app/_authed/(secrets-store)/_lib/secret-values'
import { agentForMcpIdentity } from '@/app/_authed/(space)/_server/agents-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { getSetting, upsertSetting } from '@/server/data'
import { secrets } from '@/server/secrets'

// Global MCP server list for local agents, stored in the settings table (the
// data volume) rather than an on-disk mcp-config.json file. A header or env
// value is typed text or `secret:<NAME>` (the host convention, see
// secret-values.ts); the setting only ever holds the name, and the value is
// resolved for the agent using the server (resolveMcpServerSecrets).
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
    const spaceNodes = [...space.graphs.values()].flatMap((g) => g.graph.nodes)
    for (const node of spaceNodes as McpConnectionNodeShape[]) {
      // By the bare name the providing extension declares: the host does not
      // know which owner that extension is installed under.
      if (parseType(node.type ?? '')?.bare !== 'mcp-connection' || !node.data?.name) {
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

function namesASecret(entries: KeyValue[] | undefined): boolean {
  return (entries ?? []).some((entry) => secretNameOf(entry.value ?? '') !== undefined)
}

async function resolveEntries(entries: KeyValue[] | undefined, agentNodeId: string): Promise<KeyValue[] | undefined> {
  if (!entries) {
    return entries
  }
  const out: KeyValue[] = []
  for (const entry of entries) {
    out.push({ name: entry.name, value: await secrets.resolveValue(entry.value ?? '', { nodeId: agentNodeId }) })
  }
  return out
}

/**
 * A server of the global list as one agent uses it: each header and env value
 * that names a secret (`secret:<NAME>`) replaced by the secret's value, typed
 * values as they are. The list is shared by every agent, but every use of it
 * is one agent's, so a name is looked up in the Secrets Stores on the graph
 * that holds that agent (`agentNodeId`). With no agent, a server that names a
 * secret is refused: there is nobody to look the name up for. Throws, naming
 * the server, when a name does not resolve.
 */
export async function resolveMcpServerSecrets(
  server: McpServerConfig,
  agentNodeId: string | null,
): Promise<McpServerConfig> {
  if (!namesASecret(server.headers) && !namesASecret(server.env)) {
    return server
  }
  if (!agentNodeId) {
    throw new Error(
      `MCP server "${server.name}" names a secret, which is looked up for the agent using the server, and no single agent is using it here`,
    )
  }
  try {
    return {
      ...server,
      headers: await resolveEntries(server.headers, agentNodeId),
      env: await resolveEntries(server.env, agentNodeId),
    }
  } catch (err) {
    throw new Error(`MCP server "${server.name}": ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The global list as `selection`'s agent mounts it (agent-client's
 * `loadMcpServers` hook): the agent comes from the session's `mcpIdentity`,
 * and its secrets resolve here, on every load, so a rotated secret reaches the
 * next session or turn without a save. A server whose secrets do not resolve
 * for this agent is left out of its session and logged; the other servers, and
 * other agents' sessions, are unaffected.
 */
export async function readMcpServersForAgent(selection: AgentSelection): Promise<McpServerConfig[]> {
  const servers = await readMcpServers()
  if (!servers.some((server) => namesASecret(server.headers) || namesASecret(server.env))) {
    return servers
  }
  const agent = await agentForMcpIdentity(selection.mcpIdentity)
  const out: McpServerConfig[] = []
  for (const server of servers) {
    try {
      out.push(await resolveMcpServerSecrets(server, agent?.nodeId ?? null))
    } catch (err) {
      console.warn(
        `[mcp-store] left out of ${agent ? `${agent.name}'s` : 'an unattributed'} session: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return out
}

// A name already claimed by an MCP Connection node must never also be
// registered globally — that's the exact drift this check guards against:
// a personal credential becoming visible to every agent's session. A session
// reaches its own MCP Connection node through the node's route (`call` →
// `call_tool`), never through this list.
export async function isConnectionNodeName(name: string): Promise<boolean> {
  const configs = await allConnectionNodeConfigs()
  return configs.some((server) => server.name === name)
}
