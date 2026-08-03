import type { McpServerConfig } from 'agent-client/mcp-types'

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
