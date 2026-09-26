/** The MCP server configuration family, and the config parsing and redaction helpers only it uses. */

import { checkMcpServer } from 'agent-client/mcp-check'
import type { KeyValue, McpServerConfig, McpTransport } from 'agent-client/mcp-types'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { isConnectionNodeName, readMcpServers, writeMcpServers } from '@/app/_authed/(agent)/_server/mcp-store'
import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, jsonResult, textResult } from '@/app/_authed/(mcp)/_server/tool-shared'

export const definitions = [
  {
    name: 'mcp_list',
    description:
      'List the globally-configured MCP servers available to local agents. Definitions are global (shared by every local agent). Secret values (header/env values and any URL credentials) are redacted.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'mcp_set',
    description:
      'Create or update a global MCP server by name (upsert). Provided fields override the existing entry; omitted fields are preserved. stdio transport requires `command`; http/sse require `url`. Definitions are global.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Unique server name — the key used for the upsert.' },
        transport: { type: 'string', enum: ['http', 'sse', 'stdio'], description: 'Transport type.' },
        url: { type: 'string', description: 'Endpoint URL (http/sse transports).' },
        command: { type: 'string', description: 'Executable to spawn (stdio transport).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (stdio transport).' },
        headers: {
          type: 'array',
          description: 'HTTP headers (http/sse), as { name, value } pairs.',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
        env: {
          type: 'array',
          description: 'Environment variables (stdio), as { name, value } pairs.',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'mcp_remove',
    description: 'Remove a global MCP server by name.',
    inputSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Name of the server to remove.' } },
      required: ['name'],
    },
  },
  {
    name: 'mcp_test',
    description:
      'Test connectivity to an MCP server without saving. Pass a full config (same fields as mcp_set) to test an unsaved one, or just `name` to test an already-saved server. Returns ok + tool count, or an error.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Server name; used to look up a saved config when other fields are omitted.',
        },
        transport: { type: 'string', enum: ['http', 'sse', 'stdio'] },
        url: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        headers: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
        env: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
      },
      required: ['name'],
    },
  },
]

const MCP_TRANSPORTS: McpTransport[] = ['http', 'sse', 'stdio']
const SECRET_MASK = '***'

function parseKeyValues(raw: unknown): KeyValue[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw)) {
    fail(-32602, 'headers/env must be an array of { name, value }')
  }
  return raw.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : ''
    if (!name) {
      fail(-32602, 'each headers/env entry needs a name')
    }
    return { name, value: typeof obj.value === 'string' ? obj.value : '' }
  })
}

// Build an McpServerConfig from tool args, merging onto an existing entry so
// omitted fields are preserved — lets an agent patch one field without wiping
// secret headers/env it can't see (those are redacted on read).
function mcpConfigFromArgs(args: Record<string, unknown>, existing?: McpServerConfig): McpServerConfig {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) {
    fail(-32602, 'Missing required param: name')
  }
  const transport = (typeof args.transport === 'string' ? args.transport : undefined) ?? existing?.transport ?? 'http'
  if (!MCP_TRANSPORTS.includes(transport as McpTransport)) {
    fail(-32602, `transport must be one of: ${MCP_TRANSPORTS.join(', ')}`)
  }
  const config: McpServerConfig = {
    name,
    transport: transport as McpTransport,
    url: typeof args.url === 'string' ? args.url : existing?.url,
    command: typeof args.command === 'string' ? args.command : existing?.command,
    args: Array.isArray(args.args) ? (args.args as unknown[]).map(String) : existing?.args,
    headers: parseKeyValues(args.headers) ?? existing?.headers,
    env: parseKeyValues(args.env) ?? existing?.env,
  }
  if (config.transport === 'stdio') {
    if (!config.command) {
      fail(-32602, 'stdio transport requires a command')
    }
  } else if (!config.url) {
    fail(-32602, `${config.transport} transport requires a url`)
  }
  return config
}

function redactUrl(url?: string): string | undefined {
  if (!url) {
    return url
  }
  try {
    const u = new URL(url)
    if (u.username || u.password) {
      u.username = u.username ? SECRET_MASK : ''
      u.password = u.password ? SECRET_MASK : ''
    }
    return u.toString()
  } catch {
    return url
  }
}

// Never echo secret values (header/env values, URL credentials) back to agents.
function redactMcpServer(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    url: redactUrl(server.url),
    headers: server.headers?.map((h) => ({ name: h.name, value: SECRET_MASK })),
    env: server.env?.map((e) => ({ name: e.name, value: SECRET_MASK })),
  }
}

export const handlers: Record<string, ToolHandler> = {
  // ── MCP servers ───────────────────────────────────────────────────────
  mcp_list: async () => {
    const servers = await readMcpServers()
    return jsonResult(servers.map(redactMcpServer))
  },

  mcp_set: withApprovalRequired(async (args) => {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    const servers = await readMcpServers()
    const idx = servers.findIndex((s) => s.name === name)
    // A name already claimed by an MCP Connection node has its own reachable
    // path and needs no global entry — refuse rather than let the global list
    // and the node drift into two different definitions of the same name.
    // Updating an entry that's already global (idx >= 0) is unaffected.
    if (idx < 0 && (await isConnectionNodeName(name))) {
      fail(
        -32602,
        `"${name}" is an MCP Connection node's own name — it's already reachable and doesn't need a global entry.`,
      )
    }
    const config = mcpConfigFromArgs(args, idx >= 0 ? servers[idx] : undefined)
    if (idx >= 0) {
      servers[idx] = config
    } else {
      servers.push(config)
    }
    await writeMcpServers(servers)
    await agentClient.refreshMcpServers()
    return textResult(`MCP server "${config.name}" ${idx >= 0 ? 'updated' : 'created'}.`)
  }),

  mcp_remove: withApprovalRequired(async (args) => {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) {
      fail(-32602, 'Missing required param: name')
    }
    const servers = await readMcpServers()
    const next = servers.filter((s) => s.name !== name)
    if (next.length === servers.length) {
      fail(-32602, `No MCP server named "${name}"`)
    }
    await writeMcpServers(next)
    await agentClient.refreshMcpServers()
    return textResult(`MCP server "${name}" removed.`)
  }),

  mcp_test: async (args) => {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) {
      fail(-32602, 'Missing required param: name')
    }
    const hasInline = ['transport', 'url', 'command', 'args', 'headers', 'env'].some((k) => args[k] !== undefined)
    let config: McpServerConfig
    if (hasInline) {
      config = mcpConfigFromArgs(args)
    } else {
      const existing = (await readMcpServers()).find((s) => s.name === name)
      if (!existing) {
        fail(-32602, `No MCP server named "${name}" — pass a full config to test an unsaved one`)
      }
      config = existing
    }
    return jsonResult(await checkMcpServer(config))
  },
}
