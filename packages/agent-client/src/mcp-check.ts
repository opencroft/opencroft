import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { buildTransport, MCP_TIMEOUT } from './mcp-client'
import { toAcpMcpServer } from './mcp-config'
import type { McpServerConfig } from './mcp-types'

export interface McpCheckResult {
  ok: boolean
  tools?: number
  error?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function checkMcpServer(config: McpServerConfig): Promise<McpCheckResult> {
  const spec = toAcpMcpServer(config)
  const transport = spec ? buildTransport(spec) : null
  if (!transport) {
    return { ok: false, error: 'Missing url or command' }
  }
  const client = new Client({
    name: 'agent-client-check',
    version: '0.1.0',
  })
  try {
    await client.connect(transport, { timeout: MCP_TIMEOUT })
    const { tools } = await client.listTools(undefined, { timeout: MCP_TIMEOUT })
    await client.close()
    return { ok: true, tools: tools.length }
  } catch (error) {
    await client.close().catch(() => {})
    return { ok: false, error: errorMessage(error) }
  }
}
