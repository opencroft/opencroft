import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import type { KeyValue, McpServerConfig } from './mcp-types'

export interface McpCheckResult {
  ok: boolean
  tools?: number
  error?: string
}

const TIMEOUT = 8000

function record(entries?: KeyValue[]): Record<string, string> {
  return Object.fromEntries((entries ?? []).map((entry) => [entry.name, entry.value]))
}

function buildTransport(config: McpServerConfig): Transport | null {
  if (config.transport === 'stdio') {
    if (!config.command) {
      return null
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: record(config.env),
    })
  }
  if (!config.url) {
    return null
  }
  const url = new URL(config.url)
  const requestInit = { headers: record(config.headers) }
  if (config.transport === 'sse') {
    return new SSEClientTransport(url, { requestInit })
  }
  return new StreamableHTTPClientTransport(url, { requestInit })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function checkMcpServer(config: McpServerConfig): Promise<McpCheckResult> {
  const transport = buildTransport(config)
  if (!transport) {
    return { ok: false, error: 'Missing url or command' }
  }
  const client = new Client({
    name: 'demo-chat-app-checker',
    version: '0.1.0',
  })
  try {
    await client.connect(transport, { timeout: TIMEOUT })
    const { tools } = await client.listTools(undefined, { timeout: TIMEOUT })
    await client.close()
    return { ok: true, tools: tools.length }
  } catch (error) {
    await client.close().catch(() => {})
    return { ok: false, error: errorMessage(error) }
  }
}
