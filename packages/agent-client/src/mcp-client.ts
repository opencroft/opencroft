// Shared MCP client utilities (node-side) over @modelcontextprotocol/sdk.
// One transport-branching implementation drives both the connectivity checker
// (mcp-check.ts) and the native harness's per-turn MCP toolset.

import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'

export const MCP_TIMEOUT = 8000
// Tool calls can legitimately run for minutes (long execs, prompts awaiting a
// human answer), unlike the connect/list handshake.
const MCP_CALL_TIMEOUT = 600_000

// The ACP McpServer shape is the canonical transport input here; the connectivity
// checker maps its McpServerConfig to it via toAcpMcpServer first.

function record(entries?: Array<{ name: string; value: string }>): Record<string, string> {
  return Object.fromEntries((entries ?? []).map((entry) => [entry.name, entry.value]))
}

export function buildTransport(spec: AcpMcpServer): Transport | null {
  if (!('type' in spec)) {
    if (!spec.command) {
      return null
    }
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: record(spec.env),
    })
  }
  if (spec.type === 'acp') {
    return null
  }
  if (!spec.url) {
    return null
  }
  const url = new URL(spec.url)
  const requestInit = { headers: record(spec.headers) }
  if (spec.type === 'sse') {
    return new SSEClientTransport(url, { requestInit })
  }
  return new StreamableHTTPClientTransport(url, { requestInit })
}

// Tool names are namespaced server_tool so identically named tools from
// different servers don't collide. The AI SDK tool-name grammar is restrictive,
// so sanitize to [a-zA-Z0-9_-].
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

interface CallToolContent {
  type: string
  text?: string
}

function flattenResult(content: CallToolContent[]): string {
  const parts = content.map((block) => (block.type === 'text' ? (block.text ?? '') : JSON.stringify(block)))
  return parts.join('\n')
}

export interface McpToolset {
  tools: ToolSet
  closeAll: () => Promise<void>
}

export interface ConnectMcpOptions {
  clientName?: string
  onError?: (server: string, error: unknown) => void
}

// Connect to each server, list its tools, and expose them as AI SDK dynamic
// tools. Per-server failures don't abort the toolset — they're reported and the
// server is skipped.
export async function connectMcpToolset(servers: AcpMcpServer[], opts: ConnectMcpOptions = {}): Promise<McpToolset> {
  const tools: ToolSet = {}
  const clients: Client[] = []

  for (const spec of servers) {
    const transport = buildTransport(spec)
    if (!transport) {
      continue
    }
    const client = new Client({ name: opts.clientName ?? 'agent-client', version: '0.1.0' })
    try {
      await client.connect(transport, { timeout: MCP_TIMEOUT })
      const { tools: listed } = await client.listTools(undefined, { timeout: MCP_TIMEOUT })
      clients.push(client)
      for (const remote of listed) {
        const name = `${sanitize(spec.name)}_${sanitize(remote.name)}`
        tools[name] = dynamicTool({
          description: remote.description ?? '',
          inputSchema: jsonSchema(remote.inputSchema),
          execute: async (input) => {
            const result = await client.callTool(
              { name: remote.name, arguments: input as Record<string, unknown> },
              undefined,
              { timeout: MCP_CALL_TIMEOUT },
            )
            return flattenResult((result.content ?? []) as CallToolContent[])
          },
        })
      }
    } catch (error) {
      await client.close().catch(() => {})
      if (opts.onError) {
        opts.onError(spec.name, error)
      } else {
        console.warn(`[agent-client] MCP server "${spec.name}" unavailable:`, error)
      }
    }
  }

  return {
    tools,
    closeAll: async () => {
      await Promise.all(clients.map((client) => client.close().catch(() => {})))
    },
  }
}
